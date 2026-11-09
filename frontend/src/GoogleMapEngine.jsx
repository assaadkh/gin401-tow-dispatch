import React, { useState, useEffect, useRef } from 'react';

const TILE_SIZE = 256;

// Web Mercator projection: (lat, lng, zoom) -> world pixel (x, y)
function latLngToWorldPixel(lat, lng, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const clampedSin = Math.max(-0.9999, Math.min(0.9999, sinLat));
  const y =
    (0.5 - Math.log((1 + clampedSin) / (1 - clampedSin)) / (4 * Math.PI)) * scale;
  return { x, y };
}

// Inverse Web Mercator projection: world pixel (x, y, zoom) -> (lat, lng)
function worldPixelToLatLng(x, y, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return {
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6))
  };
}

const BASE_TILE_URLS = {
  road: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
  traffic: 'https://mt1.google.com/vt/lyrs=m,traffic&x={x}&y={y}&z={z}',
  hybrid: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
};

const TRAFFIC_OVERLAY_URL =
  'https://mt1.google.com/vt?lyrs=h,traffic&x={x}&y={y}&z={z}';

/**
 * Pure React Google Maps Web Mercator CAD Engine (No Leaflet!)
 */
export function GoogleCadMap({
  centerLat = 33.8938,
  centerLng = 35.5018,
  initialZoom = 11,
  flyToTarget, // { lat, lng, zoom, ts }
  trafficEnabled = false,
  trucks = [],
  priorityQueue = [],
  activeJobs = [],
  selectedTruckId,
  selectedJobId,
  onSelectTruck,
  onSelectJob,
  onSelectRoute
}) {
  const containerRef = useRef(null);
  const [viewport, setViewport] = useState({ width: 1000, height: 600 });
  const [center, setCenter] = useState({ lat: centerLat, lng: centerLng });
  const [zoom, setZoom] = useState(initialZoom);
  const [baseLayer, setBaseLayer] = useState('road'); // 'road' | 'traffic' | 'hybrid'
  const [activePopup, setActivePopup] = useState(null); // { lat, lng, title, lines }
  const [osrmRoutes, setOsrmRoutes] = useState({}); // { [towRequestId]: [[lat,lng], ...] }

  const dragStateRef = useRef({ dragging: false, startX: 0, startY: 0, moved: false });

  // Measure container size
  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewport({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(containerRef.current);
    window.addEventListener('resize', updateSize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  // Respond to external flyTo requests
  useEffect(() => {
    if (flyToTarget && flyToTarget.lat && flyToTarget.lng) {
      setCenter({ lat: Number(flyToTarget.lat), lng: Number(flyToTarget.lng) });
      if (flyToTarget.zoom) setZoom(flyToTarget.zoom);
    }
  }, [flyToTarget]);

  // Fetch OSRM real road geometry for active jobs
  useEffect(() => {
    activeJobs.forEach(job => {
      if (osrmRoutes[job.towRequestId]) return;
      const url = `https://router.project-osrm.org/route/v1/driving/${job.pickupLng},${job.pickupLat};${job.destinationLng},${job.destinationLat}?overview=full&geometries=geojson`;
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .then(data => {
          const coords = data?.routes?.[0]?.geometry?.coordinates;
          if (coords && coords.length > 1) {
            setOsrmRoutes(prev => ({
              ...prev,
              [job.towRequestId]: coords.map(c => [c[1], c[0]])
            }));
          }
        })
        .catch(() => {});
    });
  }, [activeJobs]);

  const centerWorld = latLngToWorldPixel(center.lat, center.lng, zoom);
  const topLeftWorldX = centerWorld.x - viewport.width / 2;
  const topLeftWorldY = centerWorld.y - viewport.height / 2;

  const projectToScreen = (lat, lng) => {
    const wp = latLngToWorldPixel(Number(lat), Number(lng), zoom);
    return {
      x: wp.x - topLeftWorldX,
      y: wp.y - topLeftWorldY
    };
  };

  // Compute visible Google Maps 256x256 tiles
  const maxTileIndex = Math.pow(2, zoom);
  const startTileX = Math.floor(topLeftWorldX / TILE_SIZE);
  const endTileX = Math.floor((topLeftWorldX + viewport.width) / TILE_SIZE);
  const startTileY = Math.max(0, Math.floor(topLeftWorldY / TILE_SIZE));
  const endTileY = Math.min(
    maxTileIndex - 1,
    Math.floor((topLeftWorldY + viewport.height) / TILE_SIZE)
  );

  const tiles = [];
  const templateUrl = BASE_TILE_URLS[baseLayer] || BASE_TILE_URLS.road;

  for (let tx = startTileX; tx <= endTileX; tx++) {
    const wrappedX = ((tx % maxTileIndex) + maxTileIndex) % maxTileIndex;
    for (let ty = startTileY; ty <= endTileY; ty++) {
      const left = tx * TILE_SIZE - topLeftWorldX;
      const top = ty * TILE_SIZE - topLeftWorldY;
      const src = templateUrl
        .replace('{x}', wrappedX)
        .replace('{y}', ty)
        .replace('{z}', zoom);
      const trafficSrc = TRAFFIC_OVERLAY_URL.replace('{x}', wrappedX)
        .replace('{y}', ty)
        .replace('{z}', zoom);

      tiles.push({
        key: `${zoom}-${tx}-${ty}`,
        left,
        top,
        src,
        trafficSrc
      });
    }
  }

  // Panning handlers
  const handleMouseDown = e => {
    if (e.button !== 0) return;
    dragStateRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startWorldX: centerWorld.x,
      startWorldY: centerWorld.y,
      moved: false
    };
  };

  const handleMouseMove = e => {
    if (!dragStateRef.current.dragging) return;
    const dx = e.clientX - dragStateRef.current.startX;
    const dy = e.clientY - dragStateRef.current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      dragStateRef.current.moved = true;
    }
    const newWorldX = dragStateRef.current.startWorldX - dx;
    const newWorldY = dragStateRef.current.startWorldY - dy;
    const nextLatLng = worldPixelToLatLng(newWorldX, newWorldY, zoom);
    setCenter(nextLatLng);
  };

  const handleMouseUp = () => {
    dragStateRef.current.dragging = false;
  };

  const handleWheel = e => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    setZoom(prev => Math.max(7, Math.min(19, prev + delta)));
  };

  return (
    <div
      ref={containerRef}
      className="gmap-engine-viewport"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* 1. Google Maps Tile Layer */}
      <div className="gmap-tile-pane">
        {tiles.map(t => (
          <React.Fragment key={t.key}>
            <img
              src={t.src}
              alt=""
              draggable={false}
              className="gmap-tile-img"
              style={{ left: `${t.left}px`, top: `${t.top}px` }}
            />
            {trafficEnabled && baseLayer !== 'traffic' && (
              <img
                src={t.trafficSrc}
                alt=""
                draggable={false}
                className="gmap-tile-img"
                style={{ left: `${t.left}px`, top: `${t.top}px`, opacity: 0.9 }}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      {/* 2. SVG Vector Layer for OSRM Road Polylines & Radar Pulse Ring */}
      <svg
        className="gmap-svg-pane"
        width={viewport.width}
        height={viewport.height}
        viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      >
        {activeJobs.map(r => {
          const isJobSelected = selectedJobId === r.towRequestId;
          const isTruckSelected =
            selectedTruckId && r.assignedTruckId === selectedTruckId;
          const isHighlighted = isJobSelected || isTruckSelected;

          const rawPts = osrmRoutes[r.towRequestId] || [
            [r.pickupLat, r.pickupLng],
            [r.destinationLat, r.destinationLng]
          ];
          const pointsAttr = rawPts
            .map(([lat, lng]) => {
              const p = projectToScreen(lat, lng);
              return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
            })
            .join(' ');

          return (
            <g key={`route-${r.towRequestId}`}>
              {/* Invisible wider hit-target for easy route clicking */}
              <polyline
                points={pointsAttr}
                fill="none"
                stroke="transparent"
                strokeWidth={16}
                style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                onClick={e => {
                  e.stopPropagation();
                  onSelectRoute && onSelectRoute(r);
                }}
              />
              <polyline
                points={pointsAttr}
                fill="none"
                stroke={
                  isHighlighted
                    ? '#fde047'
                    : r.status === 'InProgress'
                    ? '#38bdf8'
                    : '#94a3b8'
                }
                strokeWidth={isHighlighted ? 6 : 4}
                strokeDasharray={
                  r.status === 'InProgress' || isHighlighted ? 'none' : '7, 7'
                }
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                onClick={e => {
                  e.stopPropagation();
                  onSelectRoute && onSelectRoute(r);
                }}
              >
                <title>{`${r.requestNumber}: ${r.pickupAddress} → ${r.destinationAddress} (${r.actualDistanceKm} km)`}</title>
              </polyline>
            </g>
          );
        })}

        {/* Pulsing Radar Highlight Circle on Selected Truck */}
        {trucks
          .filter(t => t.truckId === selectedTruckId)
          .map(t => {
            const pos = projectToScreen(t.currentLat, t.currentLng);
            return (
              <circle
                key={`radar-${t.truckId}`}
                cx={pos.x}
                cy={pos.y}
                r={28}
                fill="rgba(56, 189, 248, 0.22)"
                stroke="#38bdf8"
                strokeWidth={3}
                className="radar-pulse-ring"
              />
            );
          })}
      </svg>

      {/* 3. HTML Marker Overlay Layer (Trucks, Pickup Pins, Dropoff Pins, Popups) */}
      <div className="gmap-marker-pane">
        {/* Active Job Pickup & Dropoff Pins */}
        {activeJobs.map(r => {
          const isJobSelected = selectedJobId === r.towRequestId;
          const isTruckSelected =
            selectedTruckId && r.assignedTruckId === selectedTruckId;
          const isHighlighted = isJobSelected || isTruckSelected;
          const queueItem = priorityQueue.find(
            q => q.towRequestId === r.towRequestId
          );
          const stopNum = queueItem ? queueItem.stopNumberInTruckQueue : null;

          const pPos = projectToScreen(r.pickupLat, r.pickupLng);
          const dPos = projectToScreen(r.destinationLat, r.destinationLng);

          return (
            <React.Fragment key={`pins-${r.towRequestId}`}>
              {/* Pickup Marker */}
              <div
                className="gmap-pin"
                style={{
                  left: `${pPos.x}px`,
                  top: `${pPos.y}px`,
                  background: r.status === 'InProgress' ? '#3b82f6' : '#ef4444',
                  borderColor: isHighlighted ? '#fde047' : '#ffffff'
                }}
                onClick={e => {
                  e.stopPropagation();
                  onSelectJob && onSelectJob(r);
                  setActivePopup({
                    lat: r.pickupLat,
                    lng: r.pickupLng,
                    title: `${r.requestNumber} (${r.status})`,
                    lines: [
                      `Customer: ${r.customerName} (${r.vehiclePlate})`,
                      `Pickup: ${r.pickupAddress}`,
                      `Dropoff: ${r.destinationAddress}`,
                      `Distance: ${r.actualDistanceKm} km (Covered: ${r.allowedDistanceKm} km)`,
                      r.truckCode
                        ? `Assigned Truck: ${r.truckCode} ${
                            stopNum ? `(Stop #${stopNum})` : ''
                          }`
                        : 'Unassigned'
                    ]
                  });
                }}
              >
                📍 {stopNum ? `${stopNum}P:` : ''}{' '}
                {r.requestNumber.replace('TOW-2026-', '#')}
              </div>

              {/* Dropoff Marker */}
              <div
                className="gmap-pin gmap-pin-dropoff"
                style={{
                  left: `${dPos.x}px`,
                  top: `${dPos.y}px`
                }}
                onClick={e => {
                  e.stopPropagation();
                  setActivePopup({
                    lat: r.destinationLat,
                    lng: r.destinationLng,
                    title: `🏁 Dropoff (${r.requestNumber})`,
                    lines: [r.destinationAddress, `Distance: ${r.actualDistanceKm} km`]
                  });
                }}
              >
                🏁 {stopNum ? `${stopNum}D:` : ''}{' '}
                {r.requestNumber.replace('TOW-2026-', '#')}
              </div>
            </React.Fragment>
          );
        })}

        {/* Fleet Truck Markers */}
        {trucks.map(t => {
          const isSelected = selectedTruckId === t.truckId;
          const truckActiveJobs = priorityQueue.filter(
            q => q.assignedTruckId === t.truckId
          );
          const pos = projectToScreen(t.currentLat, t.currentLng);
          const bg =
            t.fleetStatus === 'Available'
              ? '#10b981'
              : t.fleetStatus === 'Busy'
              ? '#f59e0b'
              : '#ef4444';

          return (
            <div
              key={`truck-${t.truckId}`}
              className="gmap-truck-marker"
              style={{
                left: `${pos.x}px`,
                top: `${pos.y}px`,
                background: bg,
                borderColor: isSelected ? '#38bdf8' : '#0f172a',
                transform: `translate(-50%, -50%) scale(${isSelected ? 1.14 : 1})`
              }}
              onClick={e => {
                e.stopPropagation();
                onSelectTruck && onSelectTruck(t);
                setActivePopup({
                  lat: t.currentLat,
                  lng: t.currentLng,
                  title: `🚛 ${t.truckCode} (${t.licensePlate})`,
                  lines: [
                    `Driver: ${t.driverName} (${t.driverPhone})`,
                    `Status: ${t.fleetStatus} | Active Queue: ${truckActiveJobs.length}`,
                    `Base Salary: $${t.baseMonthlySalary} | OT: $${t.overtimeRatePerTow}/tow`
                  ]
                });
              }}
            >
              🚛 {t.truckCode}{' '}
              {truckActiveJobs.length > 0 ? `(${truckActiveJobs.length})` : ''}
            </div>
          );
        })}

        {/* Info Popup Window */}
        {activePopup && (() => {
          const popPos = projectToScreen(activePopup.lat, activePopup.lng);
          return (
            <div
              className="gmap-popup-box"
              style={{ left: `${popPos.x}px`, top: `${popPos.y - 18}px` }}
              onClick={e => e.stopPropagation()}
            >
              <div className="gmap-popup-header">
                <strong>{activePopup.title}</strong>
                <button onClick={() => setActivePopup(null)}>✕</button>
              </div>
              {activePopup.lines.map((line, i) => (
                <div key={i} className="gmap-popup-line">
                  {line}
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {/* 4. Map Controls: Zoom +/- and Google Layer Switcher */}
      <div className="gmap-zoom-controls" onClick={e => e.stopPropagation()}>
        <button
          title="Zoom In"
          onClick={() => setZoom(z => Math.min(19, z + 1))}
        >
          +
        </button>
        <button
          title="Zoom Out"
          onClick={() => setZoom(z => Math.max(7, z - 1))}
        >
          −
        </button>
      </div>

      <div className="gmap-layer-switcher" onClick={e => e.stopPropagation()}>
        <button
          className={baseLayer === 'road' ? 'active' : ''}
          onClick={() => setBaseLayer('road')}
        >
          🗺️ Road
        </button>
        <button
          className={baseLayer === 'traffic' ? 'active' : ''}
          onClick={() => setBaseLayer('traffic')}
        >
          🚦 Traffic
        </button>
        <button
          className={baseLayer === 'hybrid' ? 'active' : ''}
          onClick={() => setBaseLayer('hybrid')}
        >
          🛰️ Satellite
        </button>
      </div>

      <div className="gmap-attribution">© Google Maps Engine • OSRM Road Routing</div>
    </div>
  );
}

/**
 * Pure React Google Maps Location Picker Modal Canvas (Click or Drag Pin, No Leaflet!)
 */
export function GoogleLocationPickerMap({
  lat = 33.8938,
  lng = 35.5018,
  onPickCoordinates
}) {
  const containerRef = useRef(null);
  const [viewport, setViewport] = useState({ width: 760, height: 380 });
  const [center, setCenter] = useState({ lat, lng });
  const [zoom, setZoom] = useState(14);
  const dragRef = useRef({ mode: null, startX: 0, startY: 0, moved: false });

  useEffect(() => {
    setCenter({ lat: Number(lat), lng: Number(lng) });
  }, [lat, lng]);

  useEffect(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setViewport({ width: rect.width, height: rect.height });
    }
  }, []);

  const centerWorld = latLngToWorldPixel(center.lat, center.lng, zoom);
  const topLeftWorldX = centerWorld.x - viewport.width / 2;
  const topLeftWorldY = centerWorld.y - viewport.height / 2;

  const projectToScreen = (pLat, pLng) => {
    const wp = latLngToWorldPixel(Number(pLat), Number(pLng), zoom);
    return {
      x: wp.x - topLeftWorldX,
      y: wp.y - topLeftWorldY
    };
  };

  const maxTileIndex = Math.pow(2, zoom);
  const startTileX = Math.floor(topLeftWorldX / TILE_SIZE);
  const endTileX = Math.floor((topLeftWorldX + viewport.width) / TILE_SIZE);
  const startTileY = Math.max(0, Math.floor(topLeftWorldY / TILE_SIZE));
  const endTileY = Math.min(
    maxTileIndex - 1,
    Math.floor((topLeftWorldY + viewport.height) / TILE_SIZE)
  );

  const tiles = [];
  for (let tx = startTileX; tx <= endTileX; tx++) {
    const wrappedX = ((tx % maxTileIndex) + maxTileIndex) % maxTileIndex;
    for (let ty = startTileY; ty <= endTileY; ty++) {
      tiles.push({
        key: `${zoom}-${tx}-${ty}`,
        left: tx * TILE_SIZE - topLeftWorldX,
        top: ty * TILE_SIZE - topLeftWorldY,
        src: BASE_TILE_URLS.road
          .replace('{x}', wrappedX)
          .replace('{y}', ty)
          .replace('{z}', zoom)
      });
    }
  }

  const pinScreen = projectToScreen(lat, lng);

  const handleMouseDown = e => {
    if (e.button !== 0) return;
    dragRef.current = {
      mode: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      startWorldX: centerWorld.x,
      startWorldY: centerWorld.y,
      moved: false
    };
  };

  const handleMouseMove = e => {
    if (!dragRef.current.mode) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      dragRef.current.moved = true;
    }

    if (dragRef.current.mode === 'pan') {
      const next = worldPixelToLatLng(
        dragRef.current.startWorldX - dx,
        dragRef.current.startWorldY - dy,
        zoom
      );
      setCenter(next);
    } else if (dragRef.current.mode === 'pin' && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const picked = worldPixelToLatLng(topLeftWorldX + px, topLeftWorldY + py, zoom);
      onPickCoordinates && onPickCoordinates(picked.lat, picked.lng);
    }
  };

  const handleMouseUp = e => {
    if (
      dragRef.current.mode === 'pan' &&
      !dragRef.current.moved &&
      containerRef.current
    ) {
      // Single click on map -> drop pin at clicked position!
      const rect = containerRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const picked = worldPixelToLatLng(topLeftWorldX + px, topLeftWorldY + py, zoom);
      onPickCoordinates && onPickCoordinates(picked.lat, picked.lng);
    }
    dragRef.current.mode = null;
  };

  return (
    <div
      ref={containerRef}
      className="gmap-engine-viewport picker-leaflet-container"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => (dragRef.current.mode = null)}
      onWheel={e => {
        e.preventDefault();
        setZoom(z => Math.max(8, Math.min(19, z + (e.deltaY < 0 ? 1 : -1))));
      }}
    >
      <div className="gmap-tile-pane">
        {tiles.map(t => (
          <img
            key={t.key}
            src={t.src}
            alt=""
            draggable={false}
            className="gmap-tile-img"
            style={{ left: `${t.left}px`, top: `${t.top}px` }}
          />
        ))}
      </div>

      {/* Draggable Pin Marker */}
      <div className="gmap-marker-pane">
        <div
          className="gmap-draggable-pin"
          style={{ left: `${pinScreen.x}px`, top: `${pinScreen.y}px` }}
          onMouseDown={e => {
            e.stopPropagation();
            dragRef.current = {
              mode: 'pin',
              startX: e.clientX,
              startY: e.clientY,
              moved: false
            };
          }}
          title="Drag pin or click anywhere on the map"
        >
          📍
        </div>
      </div>

      <div className="gmap-zoom-controls" onClick={e => e.stopPropagation()}>
        <button type="button" onClick={() => setZoom(z => Math.min(19, z + 1))}>
          +
        </button>
        <button type="button" onClick={() => setZoom(z => Math.max(8, z - 1))}>
          −
        </button>
      </div>
      <div className="gmap-attribution">
        Click anywhere or drag 📍 pin • Google Maps
      </div>
    </div>
  );
}
