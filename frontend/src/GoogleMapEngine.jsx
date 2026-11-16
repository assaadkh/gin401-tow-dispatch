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

function formatStatusLabel(status) {
  if (!status) return '';
  return String(status)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace('EnRoute', 'En Route')
    .replace('OffDuty', 'Off Duty')
    .replace('OnJob', 'On Job');
}

const BASE_TILE_URLS = {
  road: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
  roadTraffic: 'https://mt1.google.com/vt/lyrs=m,traffic&x={x}&y={y}&z={z}',
  hybrid: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
  hybridTraffic: 'https://mt1.google.com/vt/lyrs=y,traffic&x={x}&y={y}&z={z}'
};

/**
 * Pure React Google Maps Web Mercator CAD Engine (Mouse + Touch + Non-Passive Wheel)
 */
export function GoogleCadMap({
  centerLat = 33.8938,
  centerLng = 35.5018,
  initialZoom = 11,
  flyToTarget,
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
  const [baseLayer, setBaseLayer] = useState('road'); // 'road' | 'hybrid'
  const [showTraffic, setShowTraffic] = useState(false);
  const [activePopup, setActivePopup] = useState(null);
  const [osrmRoutes, setOsrmRoutes] = useState({});

  const dragStateRef = useRef({
    dragging: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startWorldX: 0,
    startWorldY: 0,
    moved: false
  });

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

  // Attach non-passive wheel listener to prevent browser passive-listener console errors
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheelNative = e => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      setZoom(prev => Math.max(7, Math.min(19, prev + delta)));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, []);

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
      const pLng = Number(job.pickupLng);
      const pLat = Number(job.pickupLat);
      const dLng = Number(job.destinationLng);
      const dLat = Number(job.destinationLat);
      if (![pLng, pLat, dLng, dLat].every(Number.isFinite)) return;
      const url = `https://router.project-osrm.org/route/v1/driving/${pLng},${pLat};${dLng},${dLat}?overview=full&geometries=geojson`;
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

  const maxTileIndex = Math.pow(2, zoom);
  const startTileX = Math.floor(topLeftWorldX / TILE_SIZE);
  const endTileX = Math.floor((topLeftWorldX + viewport.width) / TILE_SIZE);
  const startTileY = Math.max(0, Math.floor(topLeftWorldY / TILE_SIZE));
  const endTileY = Math.min(
    maxTileIndex - 1,
    Math.floor((topLeftWorldY + viewport.height) / TILE_SIZE)
  );

  const tiles = [];
  const effectiveLayerKey =
    baseLayer === 'hybrid'
      ? showTraffic
        ? 'hybridTraffic'
        : 'hybrid'
      : showTraffic
        ? 'roadTraffic'
        : 'road';
  const templateUrl = BASE_TILE_URLS[effectiveLayerKey] || BASE_TILE_URLS.road;

  for (let tx = startTileX; tx <= endTileX; tx++) {
    const wrappedX = ((tx % maxTileIndex) + maxTileIndex) % maxTileIndex;
    for (let ty = startTileY; ty <= endTileY; ty++) {
      const left = tx * TILE_SIZE - topLeftWorldX;
      const top = ty * TILE_SIZE - topLeftWorldY;
      const roadSrc = BASE_TILE_URLS.road
        .replace('{x}', wrappedX)
        .replace('{y}', ty)
        .replace('{z}', zoom);
      const src = templateUrl
        .replace('{x}', wrappedX)
        .replace('{y}', ty)
        .replace('{z}', zoom);

      tiles.push({
        key: `${effectiveLayerKey}-${zoom}-${tx}-${ty}`,
        left,
        top,
        src,
        roadSrc
      });
    }
  }

  const handlePointerDown = e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.gmap-zoom-controls, .gmap-layer-switcher, .gmap-popup-box, .gmap-circle-pin, .gmap-circle-truck')) {
      return;
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore synthetic pointer capture edge cases
    }
    dragStateRef.current = {
      dragging: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startWorldX: centerWorld.x,
      startWorldY: centerWorld.y,
      moved: false
    };
  };

  const handlePointerMove = e => {
    if (!dragStateRef.current.dragging) return;
    if (dragStateRef.current.pointerId !== null && e.pointerId !== dragStateRef.current.pointerId) return;
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

  const handlePointerUp = e => {
    if (dragStateRef.current.pointerId !== null) {
      try {
        e.currentTarget.releasePointerCapture(dragStateRef.current.pointerId);
      } catch {
        // ignore
      }
    }
    dragStateRef.current.dragging = false;
    dragStateRef.current.pointerId = null;
  };

  return (
    <div
      ref={containerRef}
      className="gmap-engine-viewport"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* 1. Google Maps Tile Layer */}
      <div className="gmap-tile-pane">
        {tiles.map(t => (
          <img
            key={t.key}
            src={t.src}
            alt=""
            draggable={false}
            className="gmap-tile-img"
            style={{ left: `${t.left}px`, top: `${t.top}px` }}
            onError={e => {
              if (t.roadSrc && e.currentTarget.src !== t.roadSrc) {
                e.currentTarget.src = t.roadSrc;
              } else {
                e.currentTarget.style.opacity = '0';
              }
            }}
          />
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
              <polyline
                points={pointsAttr}
                fill="none"
                stroke="transparent"
                strokeWidth={18}
                style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                onClick={e => {
                  e.stopPropagation();
                  onSelectRoute && onSelectRoute(r);
                }}
              />
              {isHighlighted && (
                <polyline
                  points={pointsAttr}
                  fill="none"
                  stroke="rgba(255, 122, 0, 0.28)"
                  strokeWidth={12}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ pointerEvents: 'none' }}
                />
              )}
              <polyline
                points={pointsAttr}
                fill="none"
                stroke={isHighlighted ? '#FF6B00' : '#EF4444'}
                strokeWidth={isHighlighted ? 5.5 : 3.5}
                strokeDasharray={isHighlighted ? 'none' : '6, 8'}
                strokeOpacity={isHighlighted ? 1 : 0.85}
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
                r={26}
                fill="rgba(255, 122, 0, 0.22)"
                stroke="#FF6B00"
                strokeWidth={4}
                className="radar-pulse-ring"
              />
            );
          })}
      </svg>

      {/* 3. Circular Pickup, Dropoff, and Fleet Truck Markers */}
      <div className="gmap-marker-pane">
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

          const openPickupPopup = () => {
            onSelectJob && onSelectJob(r);
            setActivePopup({
              lat: r.pickupLat,
              lng: r.pickupLng,
              title: `${r.requestNumber} — Pickup`,
              lines: [
                `Customer: ${r.customerName} (${r.vehiclePlate})`,
                `Vehicle: ${r.vehicleModel} • ${r.issueType}`,
                `Pickup: ${r.pickupAddress}`,
                `Dropoff: ${r.destinationAddress}`,
                `Distance: ${r.actualDistanceKm} km (Covered: ${r.allowedDistanceKm} km)`,
                r.overageAmount > 0
                  ? `Overage: +${r.overageKm} km ($${r.overageAmount})`
                  : 'Status: Within Policy KM Limit',
                r.truckCode
                  ? `Assigned: ${r.truckCode} ${stopNum ? `(Stop #${stopNum})` : ''}`
                  : 'Assigned: Unassigned'
              ]
            });
          };

          const openDropoffPopup = () => {
            setActivePopup({
              lat: r.destinationLat,
              lng: r.destinationLng,
              title: `Destination (${r.requestNumber})`,
              lines: [r.destinationAddress, `Total Distance: ${r.actualDistanceKm} km`]
            });
          };

          return (
            <React.Fragment key={`pins-${r.towRequestId}`}>
              {/* Pickup Circular Marker */}
              <div
                role="button"
                tabIndex={0}
                aria-label={`Pickup ${r.requestNumber} at ${r.pickupAddress}`}
                className="gmap-circle-pin"
                title={`Pickup: ${r.requestNumber} (${r.pickupAddress})`}
                style={{
                  left: `${pPos.x}px`,
                  top: `${pPos.y}px`,
                  background: isHighlighted ? '#FF6B00' : '#EF4444',
                  transform: `translate(-50%, -50%) scale(${isHighlighted ? 1.16 : 1})`
                }}
                onClick={e => {
                  e.stopPropagation();
                  openPickupPopup();
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPickupPopup();
                  }
                }}
              >
                {stopNum ? `${stopNum}P` : 'P'}
              </div>

              {/* Dropoff Circular Marker */}
              <div
                role="button"
                tabIndex={0}
                aria-label={`Dropoff ${r.requestNumber} at ${r.destinationAddress}`}
                className="gmap-circle-pin gmap-circle-pin-dropoff"
                title={`Dropoff: ${r.requestNumber} (${r.destinationAddress})`}
                style={{
                  left: `${dPos.x}px`,
                  top: `${dPos.y}px`,
                  background: stopNum ? '#1e293b' : '#059669'
                }}
                onClick={e => {
                  e.stopPropagation();
                  openDropoffPopup();
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openDropoffPopup();
                  }
                }}
              >
                {stopNum ? `${stopNum}D` : 'D'}
              </div>
            </React.Fragment>
          );
        })}

        {/* Fleet Truck Circular Markers */}
        {trucks.map(t => {
          const isSelected = selectedTruckId === t.truckId;
          const truckActiveJobs = priorityQueue.filter(
            q => q.assignedTruckId === t.truckId
          );
          const pos = projectToScreen(t.currentLat, t.currentLng);
          const bg =
            t.fleetStatus === 'Available'
              ? '#059669'
              : t.fleetStatus === 'EnRoute'
              ? '#2563EB'
              : t.fleetStatus === 'Towing' || t.fleetStatus === 'OnJob' || t.fleetStatus === 'Busy'
              ? '#D97706'
              : '#64748b';
          const shortCode = String(t.truckCode || '').replace('TRK-', 'T');

          const openTruckPopup = () => {
            onSelectTruck && onSelectTruck(t);
            setActivePopup({
              lat: t.currentLat,
              lng: t.currentLng,
              title: `${t.truckCode} (${t.licensePlate})`,
              lines: [
                `Driver: ${t.driverName || 'Unassigned'}${t.driverPhone ? ` (${t.driverPhone})` : ''}`,
                `Status: ${formatStatusLabel(t.fleetStatus)} • Speed: ${t.speedKmh} km/h`,
                `Active Stop Queue: ${truckActiveJobs.length} job(s)`,
                t.truckModel ? `Unit: ${t.truckModel}` : null
              ].filter(Boolean)
            });
          };

          return (
            <div
              key={`truck-${t.truckId}`}
              role="button"
              tabIndex={0}
              aria-label={`Truck ${t.truckCode}, ${formatStatusLabel(t.fleetStatus)}`}
              className="gmap-circle-truck"
              title={`${t.truckCode} (${t.driverName || 'Unassigned'} - ${formatStatusLabel(t.fleetStatus)})`}
              style={{
                left: `${pos.x}px`,
                top: `${pos.y}px`,
                background: bg,
                borderColor: isSelected ? '#FF6B00' : '#ffffff',
                transform: `translate(-50%, -50%) scale(${isSelected ? 1.22 : 1})`
              }}
              onClick={e => {
                e.stopPropagation();
                openTruckPopup();
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openTruckPopup();
                }
              }}
            >
              <span style={{ fontSize: '10.5px', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.02em' }}>
                {shortCode}
              </span>
              {truckActiveJobs.length > 0 && (
                <span className="gmap-truck-count-badge">{truckActiveJobs.length}</span>
              )}
            </div>
          );
        })}

        {/* Clamped Info Popup Window (never clips off viewport edges) */}
        {activePopup &&
          (() => {
            const popPos = projectToScreen(activePopup.lat, activePopup.lng);
            const halfW = Math.min(145, Math.max(110, viewport.width * 0.38));
            const clampedX = Math.max(
              halfW + 8,
              Math.min(viewport.width - halfW - 8, popPos.x)
            );
            const showBelow = popPos.y < 185;
            const clampedY = showBelow
              ? Math.min(viewport.height - 80, Math.max(16, popPos.y + 22))
              : Math.min(viewport.height - 20, popPos.y - 22);

            return (
              <div
                className="gmap-popup-box"
                style={{
                  left: `${clampedX}px`,
                  top: `${clampedY}px`,
                  transform: showBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)'
                }}
                onClick={e => e.stopPropagation()}
              >
                <div className="gmap-popup-header">
                  <strong>{activePopup.title}</strong>
                  <button
                    type="button"
                    aria-label="Close map popup"
                    title="Close"
                    onClick={() => setActivePopup(null)}
                  >
                    ✕
                  </button>
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
          type="button"
          aria-label="Zoom in"
          title="Zoom In"
          onClick={() => setZoom(z => Math.min(19, z + 1))}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom Out"
          onClick={() => setZoom(z => Math.max(7, z - 1))}
        >
          −
        </button>
      </div>

      <div className="gmap-layer-switcher" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          className={baseLayer === 'road' ? 'active' : ''}
          onClick={() => setBaseLayer('road')}
        >
          Road
        </button>
        <button
          type="button"
          className={baseLayer === 'hybrid' ? 'active' : ''}
          onClick={() => setBaseLayer('hybrid')}
        >
          Satellite
        </button>
        <span className="gmap-layer-divider" aria-hidden="true" />
        <button
          type="button"
          aria-pressed={showTraffic}
          className={showTraffic ? 'traffic-toggle active' : 'traffic-toggle'}
          onClick={() => setShowTraffic(prev => !prev)}
        >
          {showTraffic ? 'Traffic: ON' : 'Traffic'}
        </button>
      </div>

      <div className="gmap-attribution">© Google Maps Engine • OSRM Road Routing</div>
    </div>
  );
}

/**
 * Pure React Google Maps Location Picker Modal Canvas (Mouse + Touch + ResizeObserver)
 */
export function GoogleLocationPickerMap({
  lat = 33.8938,
  lng = 35.5018,
  onPickCoordinates
}) {
  const containerRef = useRef(null);
  const [viewport, setViewport] = useState({ width: 760, height: 360 });
  const [center, setCenter] = useState({ lat, lng });
  const [zoom, setZoom] = useState(14);
  const dragRef = useRef({
    mode: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    startWorldX: 0,
    startWorldY: 0,
    moved: false
  });

  useEffect(() => {
    setCenter({ lat: Number(lat), lng: Number(lng) });
  }, [lat, lng]);

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheelNative = e => {
      e.preventDefault();
      setZoom(z => Math.max(8, Math.min(19, z + (e.deltaY < 0 ? 1 : -1))));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
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

  const handlePointerDown = e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.gmap-zoom-controls')) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = {
      mode: 'pan',
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startWorldX: centerWorld.x,
      startWorldY: centerWorld.y,
      moved: false
    };
  };

  const handlePointerMove = e => {
    if (!dragRef.current.mode) return;
    if (dragRef.current.pointerId !== null && e.pointerId !== dragRef.current.pointerId) return;
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

  const handlePointerUp = e => {
    if (
      dragRef.current.mode === 'pan' &&
      !dragRef.current.moved &&
      containerRef.current
    ) {
      const rect = containerRef.current.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const picked = worldPixelToLatLng(topLeftWorldX + px, topLeftWorldY + py, zoom);
      onPickCoordinates && onPickCoordinates(picked.lat, picked.lng);
    }
    if (dragRef.current.pointerId !== null) {
      try {
        e.currentTarget.releasePointerCapture(dragRef.current.pointerId);
      } catch {
        // ignore
      }
    }
    dragRef.current.mode = null;
    dragRef.current.pointerId = null;
  };

  return (
    <div
      ref={containerRef}
      className="gmap-engine-viewport picker-leaflet-container"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragRef.current.mode = null;
        dragRef.current.pointerId = null;
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
            onError={e => {
              e.currentTarget.style.opacity = '0';
            }}
          />
        ))}
      </div>

      {/* Draggable Pin Marker */}
      <div className="gmap-marker-pane">
        <div
          className="gmap-draggable-pin"
          style={{ left: `${pinScreen.x}px`, top: `${pinScreen.y}px` }}
          onPointerDown={e => {
            e.stopPropagation();
            if (containerRef.current) {
              try {
                containerRef.current.setPointerCapture(e.pointerId);
              } catch {
                // ignore
              }
            }
            dragRef.current = {
              mode: 'pin',
              pointerId: e.pointerId,
              startX: e.clientX,
              startY: e.clientY,
              startWorldX: centerWorld.x,
              startWorldY: centerWorld.y,
              moved: false
            };
          }}
          title="Drag pin or tap anywhere on the map"
        >
          <svg width="36" height="44" viewBox="0 0 36 44" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18 0C8.059 0 0 8.059 0 18c0 12.45 15.65 24.42 16.82 25.3a1.98 1.98 0 002.36 0C20.35 42.42 36 30.45 36 18 36 8.059 27.941 0 18 0z" fill="#FF6B00"/>
            <path d="M18 2C9.163 2 2 9.163 2 18c0 10.72 13.06 21.48 16 23.82C20.94 39.48 34 28.72 34 18 34 9.163 26.837 2 18 2z" stroke="#FFFFFF" strokeOpacity="0.45" strokeWidth="1.5"/>
            <circle cx="18" cy="18" r="7" fill="#FFFFFF"/>
            <circle cx="18" cy="18" r="3.5" fill="#0B0F19"/>
          </svg>
        </div>
      </div>

      <div className="gmap-zoom-controls" onClick={e => e.stopPropagation()}>
        <button
          type="button"
          aria-label="Zoom in location map"
          title="Zoom In"
          onClick={() => setZoom(z => Math.min(19, z + 1))}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Zoom out location map"
          title="Zoom Out"
          onClick={() => setZoom(z => Math.max(8, z - 1))}
        >
          −
        </button>
      </div>
      <div className="gmap-attribution">
        Tap anywhere or drag pin • Google Maps
      </div>
    </div>
  );
}
