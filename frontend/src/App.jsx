import React, { useState, useEffect, useRef } from 'react';

const API_BASE = 'http://localhost:5050';

export default function App() {
  const [activeTab, setActiveTab] = useState('map');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  // Tab 2: Call Intake & Policy Eligibility State
  const [selectedPolicyId, setSelectedPolicyId] = useState(1);
  const [hasInsurance, setHasInsurance] = useState(true);
  const [plateCodeId, setPlateCodeId] = useState(2); // M (Metn)
  const [plateDigits, setPlateDigits] = useState('541890');
  const [noPlate, setNoPlate] = useState(false);
  const [vehicleModel, setVehicleModel] = useState('BMW 520i');
  const [issueType, setIssueType] = useState('Mechanical');
  const [issueNotes, setIssueNotes] = useState('Engine overheating on highway shoulder');
  const [pickupAddress, setPickupAddress] = useState('Dora Highway Bridge, Metn');
  const [pickupLat, setPickupLat] = useState(33.8983);
  const [pickupLng, setPickupLng] = useState(35.5524);
  const [destAddress, setDestAddress] = useState('Bouchrieh Certified Workshop');
  const [destLat, setDestLat] = useState(33.8869);
  const [destLng, setDestLng] = useState(35.5131);
  const [assignedTruckId, setAssignedTruckId] = useState(3);
  const [autoApprove, setAutoApprove] = useState(true);
  const [eligibility, setEligibility] = useState(null);

  // Tab 3: Dispatch Board State
  const [dispatchTruckChoice, setDispatchTruckChoice] = useState({});
  const [triggerTestResult, setTriggerTestResult] = useState(null);

  // Tab 4: Concurrency Race & Optimistic ROWVERSION State
  const [raceRunning, setRaceRunning] = useState(false);
  const [raceResult, setRaceResult] = useState(null);
  const [optimisticResult, setOptimisticResult] = useState(null);

  // Tab 5: >120,000-Row Performance Explorer State
  const [perfMode, setPerfMode] = useState('status_date');
  const [perfPolicyId, setPerfPolicyId] = useState(42);
  const [perfIssueType, setPerfIssueType] = useState('Mechanical');
  const [perfStatus, setPerfStatus] = useState('Done');
  const [perfStartDate, setPerfStartDate] = useState('2026-10-01');
  const [perfEndDate, setPerfEndDate] = useState('2026-11-01');
  const [perfPlate, setPerfPlate] = useState('M 100001');
  const [perfResult, setPerfResult] = useState(null);
  const [perfLoading, setPerfLoading] = useState(false);

  // Leaflet Map reference
  const mapRef = useRef(null);
  const mapLayerGroupRef = useRef(null);

  const showNotice = (msg, isError = false) => {
    setToast({ msg, isError });
    setTimeout(() => setToast(null), 6500);
  };

  const loadDashboard = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard`);
      const data = await res.json();
      setDashboard(data);
      setLoading(false);
    } catch (err) {
      showNotice('Could not connect to C# ADO.NET API on port 5050.', true);
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  // Re-evaluate T-SQL tvf_CheckPolicyEligibility whenever Policy, IssueType, or Coordinates change
  useEffect(() => {
    if (!hasInsurance || !selectedPolicyId) {
      setEligibility(null);
      return;
    }
    const checkPolicy = async () => {
      try {
        const url = `${API_BASE}/api/policies/${selectedPolicyId}/check-eligibility?issueType=${encodeURIComponent(
          issueType
        )}&lat1=${pickupLat}&lng1=${pickupLng}&lat2=${destLat}&lng2=${destLng}`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          setEligibility(data);
        }
      } catch {
        // ignore transient error
      }
    };
    checkPolicy();
  }, [selectedPolicyId, issueType, hasInsurance, pickupLat, pickupLng, destLat, destLng, dashboard]);

  // Render Leaflet CAD Map when on Map Tab
  useEffect(() => {
    if (activeTab !== 'map' || !dashboard || !window.L) return;

    const L = window.L;
    if (!mapRef.current) {
      const map = L.map('cad-leaflet-map').setView([33.91, 35.56], 11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors — GIN401 CAD Live Telemetry',
      }).addTo(map);
      mapRef.current = map;
      mapLayerGroupRef.current = L.layerGroup().addTo(map);
    }

    const group = mapLayerGroupRef.current;
    group.clearLayers();

    // 1. Plot Fleet Tow Trucks
    dashboard.trucks.forEach((t) => {
      const color =
        t.fleetStatus === 'Available'
          ? '#10b981'
          : t.fleetStatus === 'EnRoute'
          ? '#3b82f6'
          : t.fleetStatus === 'Towing'
          ? '#8b5cf6'
          : '#64748b';

      const icon = L.divIcon({
        className: 'custom-truck-pin',
        html: `<div style="background:${color};color:#fff;padding:4px 8px;border-radius:6px;font-weight:700;font-size:11px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.5);white-space:nowrap;">🛻 ${t.truckCode} (${t.fleetStatus})</div>`,
        iconSize: [110, 26],
      });

      L.marker([t.currentLat, t.currentLng], { icon })
        .bindPopup(
          `<b>${t.truckCode} — ${t.licensePlate}</b><br/>Driver: ${t.driverName}<br/>Phone: ${t.driverPhone}<br/>Status: <b>${t.fleetStatus}</b> (${t.speedKmh} km/h)<br/>Max Payload: ${t.maxPayloadKg} kg`
        )
        .addTo(group);
    });

    // 2. Plot Active Priority Queue Stops & Route Lines
    dashboard.priorityQueue.forEach((job) => {
      const truck = dashboard.trucks.find((tr) => tr.truckId === job.assignedTruckId);
      const stopColor = job.stopNumberInTruckQueue === 1 ? '#ef4444' : '#f59e0b';

      const pinIcon = L.divIcon({
        className: 'custom-job-pin',
        html: `<div style="background:${stopColor};color:#fff;padding:3px 7px;border-radius:99px;font-weight:700;font-size:11px;border:2px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.5);white-space:nowrap;">📍 ${job.truckCode} Stop #${job.stopNumberInTruckQueue} (${job.vehiclePlate})</div>`,
        iconSize: [140, 24],
      });

      L.marker([job.pickupLat, job.pickupLng], { icon: pinIcon })
        .bindPopup(
          `<b>${job.requestNumber} (Stop #${job.stopNumberInTruckQueue} — Priority ${job.truckPrioritySequence})</b><br/>Vehicle: ${job.vehiclePlate} (${job.vehicleModel})<br/>Issue: ${job.issueType} [${job.status}]<br/>Pickup: ${job.pickupAddress}<br/>Dropoff: ${job.destinationAddress}<br/>Distance: ${job.actualDistanceKm} KM (Cumulative: ${job.cumulativeQueueDistanceKm} KM)`
        )
        .addTo(group);

      if (truck) {
        L.polyline(
          [
            [truck.currentLat, truck.currentLng],
            [job.pickupLat, job.pickupLng],
            [job.destinationLat, job.destinationLng],
          ],
          {
            color: stopColor,
            weight: 3,
            dashArray: job.stopNumberInTruckQueue === 1 ? null : '6, 6',
          }
        ).addTo(group);
      }
    });

    return () => {};
  }, [activeTab, dashboard]);

  // Destroy map instance when switching away from Map tab so it cleanly remounts
  useEffect(() => {
    if (activeTab !== 'map' && mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      mapLayerGroupRef.current = null;
    }
  }, [activeTab]);

  // Submit New Tow Request (calls dbo.usp_CreateTowRequest)
  const handleCreateTowRequest = async (e) => {
    e.preventDefault();
    const selectedPol = dashboard?.policies.find((p) => p.policyId === Number(selectedPolicyId));
    const customerId = selectedPol ? selectedPol.customerId : 1;
    const callerPhone = selectedPol ? selectedPol.customerPhone : '+961-03-111222';

    try {
      const res = await fetch(`${API_BASE}/api/tow-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId,
          callerPhone,
          plateCodeId: noPlate ? null : Number(plateCodeId),
          plateDigits: noPlate ? null : plateDigits,
          noPlate,
          vehicleModel,
          issueType,
          issueNotes,
          pickupAddress,
          pickupLat: Number(pickupLat),
          pickupLng: Number(pickupLng),
          destinationAddress: destAddress,
          destinationLat: Number(destLat),
          destinationLng: Number(destLng),
          hasInsurance,
          policyId: hasInsurance ? Number(selectedPolicyId) : null,
          assignedTruckId: autoApprove ? Number(assignedTruckId) : null,
          autoApprove,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showNotice(`SQL Server Blocked Request (Error ${data.sqlErrorNumber || ''}): ${data.error}`, true);
      } else {
        showNotice(
          `Created ${data.data?.requestNumber || 'Tow Request'} [${data.data?.status}] via dbo.usp_CreateTowRequest!`
        );
        await loadDashboard();
      }
    } catch (err) {
      showNotice(err.message, true);
    }
  };

  // Approve & Dispatch an existing Draft (calls dbo.usp_ApproveAndDispatchTow)
  const handleDispatchDraft = async (towRequestId) => {
    const truckId = Number(dispatchTruckChoice[towRequestId] || 3);
    try {
      const res = await fetch(`${API_BASE}/api/tow-requests/${towRequestId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignedTruckId: truckId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showNotice(`Transaction Rolled Back (SQL Error ${data.sqlErrorNumber}): ${data.error}`, true);
      } else {
        showNotice(
          `Dispatched ${data.requestNumber} to Truck #${data.assignedTruckId} (Priority Seq: ${data.truckPrioritySequence}, Overage: $${data.overageAmount})`
        );
        await loadDashboard();
      }
    } catch (err) {
      showNotice(err.message, true);
    }
  };

  // Lifecycle Transition (InProgress, Done, UnableToLoad, Rejected)
  const handleStatusChange = async (towRequestId, newStatus, overageAmt = 0) => {
    try {
      const res = await fetch(`${API_BASE}/api/tow-requests/${towRequestId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newStatus,
          cashCollected: newStatus === 'Done' ? Number(overageAmt) : 0,
          rejectionReason: newStatus === 'Rejected' ? 'Rejected by Dispatcher' : null,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showNotice(`SQL Error ${data.sqlErrorNumber}: ${data.error}`, true);
      } else {
        showNotice(data.message);
        await loadDashboard();
      }
    } catch (err) {
      showNotice(err.message, true);
    }
  };

  // Test Immutability Trigger on a finalized ('Done'/'UnableToLoad'/'Rejected') ticket
  const handleTestImmutabilityTrigger = async (req) => {
    try {
      const res = await fetch(`${API_BASE}/api/tow-requests/${req.towRequestId}/test-immutability-trigger`, {
        method: 'POST',
      });
      const data = await res.json();
      setTriggerTestResult({
        requestNumber: req.requestNumber,
        status: req.status,
        ...data,
      });
      if (data.blockedByTrigger) {
        showNotice(`Trigger Blocked Update (SQL Error ${data.sqlErrorNumber}): ${data.triggerMessage}`, true);
      }
    } catch (err) {
      showNotice(err.message, true);
    }
  };

  // Run 2-Dispatcher Concurrency Race on Policy #2 ('POL-2026-ACC-LAST1' — 1 Accident Tow Left)
  const handleRunRaceSimulation = async () => {
    setRaceRunning(true);
    setRaceResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/concurrency/simulate-race`, { method: 'POST' });
      const data = await res.json();
      setRaceResult(data);
      await loadDashboard();
      showNotice('2-Dispatcher Race Completed! User 1 COMMITTED; User 2 ROLLED BACK cleanly via UPDLOCK + TRY...CATCH.');
    } catch (err) {
      showNotice(err.message, true);
    } finally {
      setRaceRunning(false);
    }
  };

  // Run Optimistic Concurrency (ROWVERSION) Conflict Demo
  const handleRunOptimisticDemo = async () => {
    const draft = dashboard?.recentRequests.find((r) => r.status === 'Draft');
    if (!draft) {
      showNotice('Create or select a Draft request first.', true);
      return;
    }
    const staleRowVer = draft.rowVerHex;

    // 1. User 1 updates the draft with the valid RowVer (succeeds and increments RowVer in SQL Server)
    const res1 = await fetch(`${API_BASE}/api/tow-requests/${draft.towRequestId}/optimistic-edit`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issueType: draft.issueType,
        issueNotes: 'Updated by Dispatcher #1 at ' + new Date().toLocaleTimeString(),
        expectedRowVerHex: staleRowVer,
      }),
    });
    const data1 = await res1.json();

    // 2. User 2 tries to save using the same original (now stale) RowVerHex -> SQL Server THROW 50020!
    const res2 = await fetch(`${API_BASE}/api/tow-requests/${draft.towRequestId}/optimistic-edit`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        issueType: draft.issueType,
        issueNotes: 'Conflicting save by Dispatcher #2 with stale ROWVERSION',
        expectedRowVerHex: staleRowVer,
      }),
    });
    const data2 = await res2.json();

    setOptimisticResult({
      ticket: draft.requestNumber,
      initialRowVer: staleRowVer,
      user1Result: data1,
      user2Result: data2,
    });
    await loadDashboard();
  };

  // Run >120,000-Row Performance Search
  const runPerformanceQuery = async (overrideMode, overridePlate) => {
    const m = overrideMode || perfMode;
    const p = overridePlate !== undefined ? overridePlate : perfPlate;
    setPerfLoading(true);
    try {
      const params = new URLSearchParams({
        mode: m,
        policyId: perfPolicyId,
        issueType: perfIssueType,
        status: perfStatus,
        startDate: perfStartDate,
        endDate: perfEndDate,
        vehiclePlate: p,
      });
      const res = await fetch(`${API_BASE}/api/performance/search?${params.toString()}`);
      const data = await res.json();
      setPerfResult(data);
    } catch (err) {
      showNotice(err.message, true);
    } finally {
      setPerfLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'performance' && !perfResult) {
      runPerformanceQuery('status_date');
    }
  }, [activeTab]);

  if (loading) {
    return (
      <div className="app-shell">
        <div className="card">Loading GIN401 Towing CAD System from SQL Server 2025 via ADO.NET...</div>
      </div>
    );
  }

  const kpis = dashboard?.kpis || {};
  const selectedPolicyObj = dashboard?.policies.find((p) => p.policyId === Number(selectedPolicyId));

  return (
    <div className="app-shell">
      {/* Toast Notification */}
      {toast && (
        <div
          className={`banner ${toast.isError ? 'banner-err' : 'banner-ok'}`}
          style={{ position: 'fixed', top: 16, right: 20, zIndex: 9999, maxWidth: 620, boxShadow: '0 10px 25px rgba(0,0,0,0.6)' }}
        >
          {toast.msg}
        </div>
      )}

      {/* Top Header */}
      <header className="top-header">
        <div className="brand-title">
          <span className="brand-badge">GIN401 LAB PROJECT</span>
          <div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 800 }}>
              Roadside Assistance, Insurance Quota &amp; Towing CAD Dispatch
            </h1>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              SQL Server 2025 · C# 9 ADO.NET (Parameterized <span className="mono">SqlCommand</span>) · React.js
            </div>
          </div>
        </div>
        <div className="security-pill">
          🔒 SQL Login: <b>{kpis.connectedSqlLogin}</b> | Role: <b>db_tow_dispatcher_role</b> (SysAdmin: {kpis.isSysAdmin})
        </div>
      </header>

      {/* KPI Cards */}
      <section className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Rows in dbo.TowRequests</div>
          <div className="kpi-value" style={{ color: '#60a5fa' }}>
            {Number(kpis.totalTowRequests || 0).toLocaleString()}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active Fleet Queue</div>
          <div className="kpi-value" style={{ color: '#c084fc' }}>{kpis.activeDispatches} Jobs</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Available Tow Trucks</div>
          <div className="kpi-value" style={{ color: '#34d399' }}>{kpis.availableTrucks} Trucks</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active Insurance Policies</div>
          <div className="kpi-value">{kpis.activePolicies}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Trigger Audit Trail Rows</div>
          <div className="kpi-value" style={{ color: '#fbbf24' }}>{kpis.totalAuditLogs}</div>
        </div>
      </section>

      {/* Navigation Tabs */}
      <nav className="nav-tabs">
        <button className={`tab-btn ${activeTab === 'map' ? 'active' : ''}`} onClick={() => setActiveTab('map')}>
          🗺️ 1. Live CAD Map &amp; Window Functions Queue
        </button>
        <button className={`tab-btn ${activeTab === 'intake' ? 'active' : ''}`} onClick={() => setActiveTab('intake')}>
          📞 2. Call Intake &amp; Policy Quota / Cooldown Check
        </button>
        <button className={`tab-btn ${activeTab === 'board' ? 'active' : ''}`} onClick={() => setActiveTab('board')}>
          📋 3. Dispatch Board &amp; Trigger Immutability
        </button>
        <button
          className={`tab-btn ${activeTab === 'concurrency' ? 'active' : ''}`}
          onClick={() => setActiveTab('concurrency')}
        >
          ⚡ 4. Live 2-User Concurrency Lab (UPDLOCK &amp; ROWVERSION)
        </button>
        <button
          className={`tab-btn ${activeTab === 'performance' ? 'active' : ''}`}
          onClick={() => setActiveTab('performance')}
        >
          🚀 5. &gt;120k Rows Performance &amp; SQL Injection Lab
        </button>
      </nav>

      {/* =====================================================================
          TAB 1: LIVE CAD MAP & FLEET PRIORITY QUEUE (WINDOW FUNCTIONS)
      ===================================================================== */}
      {activeTab === 'map' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">
              <span>🛰️ Live Lebanon Fleet Telemetry &amp; Multi-Stop Route Map</span>
              <button className="btn btn-sm btn-outline" onClick={loadDashboard}>
                ↻ Refresh Telemetry
              </button>
            </div>
            <div id="cad-leaflet-map"></div>
            <div style={{ marginTop: 10, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Click any truck or breakdown pin to inspect driver telemetry, stop priority sequence, and overage billing.
            </div>
          </div>

          <div>
            <div className="card">
              <div className="card-title">
                <span>📊 Active Priority Queue (<span className="mono">dbo.vw_FleetPriorityQueueAndRankings</span>)</span>
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: 10 }}>
                Powered by SQL Server Window Functions:{' '}
                <span className="mono">ROW_NUMBER() OVER (PARTITION BY AssignedTruckId ORDER BY TruckPrioritySequence)</span> and{' '}
                <span className="mono">SUM(ActualDistanceKm) OVER (...)</span>.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Truck</th>
                      <th>Stop #</th>
                      <th>Ticket &amp; Plate</th>
                      <th>Issue</th>
                      <th>Status</th>
                      <th>Leg KM</th>
                      <th>Cumul. KM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard?.priorityQueue.map((q) => (
                      <tr key={q.towRequestId}>
                        <td>
                          <b>{q.truckCode}</b>
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{q.driverName}</div>
                        </td>
                        <td>
                          <span className="badge badge-Approved">
                            Stop #{q.stopNumberInTruckQueue} (Seq {q.truckPrioritySequence})
                          </span>
                        </td>
                        <td>
                          <div className="mono">{q.requestNumber}</div>
                          <b>{q.vehiclePlate}</b> · {q.vehicleModel}
                        </td>
                        <td>{q.issueType}</td>
                        <td>
                          <span className={`badge badge-${q.status}`}>{q.status}</span>
                        </td>
                        <td>{q.actualDistanceKm} KM</td>
                        <td>
                          <b>{q.cumulativeQueueDistanceKm} KM</b>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <div className="card-title">🛻 Live Tow Truck Fleet Status (<span className="mono">dbo.TowTrucks</span>)</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Plate</th>
                      <th>Driver</th>
                      <th>Status</th>
                      <th>Speed</th>
                      <th>Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard?.trucks.map((t) => (
                      <tr key={t.truckId}>
                        <td><b>{t.truckCode}</b></td>
                        <td className="mono">{t.licensePlate}</td>
                        <td>{t.driverName}</td>
                        <td>
                          <span className={`badge badge-${t.fleetStatus}`}>{t.fleetStatus}</span>
                        </td>
                        <td>{t.speedKmh} km/h</td>
                        <td>{t.maxPayloadKg} kg</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 2: CALL INTAKE & POLICY QUOTA / COOLDOWN CHECKER
      ===================================================================== */}
      {activeTab === 'intake' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">
              <span>📞 Roadside Call Intake (<span className="mono">dbo.usp_CreateTowRequest</span>)</span>
            </div>

            {/* Quick Policy Scenario Presets */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginBottom: 6 }}>
                ⚡ 1-Click Test Policy Scenarios (Demonstrates Sequential Tiers, Cooldown &amp; Quota Exhaustion):
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => {
                    setHasInsurance(true);
                    setSelectedPolicyId(1);
                    setIssueType('Mechanical');
                  }}
                >
                  ✅ Policy #1: Multi-Tier VIP (Eligible)
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => {
                    setHasInsurance(true);
                    setSelectedPolicyId(3);
                    setIssueType('Mechanical');
                  }}
                >
                  ⏳ Policy #3: 7-Day Cooldown Violated (Last tow 2d ago)
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => {
                    setHasInsurance(true);
                    setSelectedPolicyId(4);
                    setIssueType('Accident');
                  }}
                >
                  ❌ Policy #4: Accident Quota Exhausted (0 Left)
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => {
                    setHasInsurance(true);
                    setSelectedPolicyId(5);
                    setIssueType('Mechanical');
                  }}
                >
                  📅 Policy #5: Expired Policy
                </button>
              </div>
            </div>

            {/* Live Policy Eligibility Banner from T-SQL tvf_CheckPolicyEligibility */}
            {hasInsurance && eligibility && (
              <div className={`banner ${eligibility.isEligible ? 'banner-ok' : 'banner-err'}`}>
                <div>{eligibility.statusBanner}</div>
                <div style={{ fontSize: '0.78rem', marginTop: 4, opacity: 0.9 }}>
                  Road Distance (<span className="mono">fn_CalculateRoadDistanceKm</span>): <b>{eligibility.calculatedRoadKm} KM</b> |
                  Policy Covered KM: <b>{eligibility.allowedDistanceKm} KM</b> | Excess Overage:{' '}
                  <b>
                    {eligibility.overageKm} KM (${eligibility.overageAmount})
                  </b>
                </div>
              </div>
            )}

            <form onSubmit={handleCreateTowRequest}>
              <div className="form-grid">
                <div className="form-group">
                  <label>Insurance Policy &amp; Customer</label>
                  <select
                    value={selectedPolicyId}
                    onChange={(e) => setSelectedPolicyId(Number(e.target.value))}
                    disabled={!hasInsurance}
                  >
                    {dashboard?.policies.map((p) => (
                      <option key={p.policyId} value={p.policyId}>
                        {p.policyNumber} — {p.customerName} ({p.policyStatus})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Breakdown Issue Type</label>
                  <select value={issueType} onChange={(e) => setIssueType(e.target.value)}>
                    <option value="Mechanical">Mechanical Breakdown</option>
                    <option value="Accident">Accident Tow</option>
                    <option value="Winch">Ditch / Winch Extraction (Accident Tier)</option>
                    <option value="Battery">Dead Battery</option>
                    <option value="Tire">Flat Tire</option>
                    <option value="Other">Other Issue</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>Lebanese Plate Letter (<span className="mono">dbo.PlateCodes</span>)</label>
                  <select
                    value={plateCodeId}
                    onChange={(e) => setPlateCodeId(Number(e.target.value))}
                    disabled={noPlate}
                  >
                    {dashboard?.plateCodes.map((pc) => (
                      <option key={pc.plateCodeId} value={pc.plateCodeId}>
                        {pc.code} — {pc.regionDescription}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>
                    Plate Digits{' '}
                    <span style={{ float: 'right' }}>
                      <input
                        type="checkbox"
                        checked={noPlate}
                        onChange={(e) => setNoPlate(e.target.checked)}
                        style={{ marginRight: 4 }}
                      />
                      No Plate
                    </span>
                  </label>
                  <input
                    type="text"
                    value={noPlate ? 'NO-PLATE' : plateDigits}
                    onChange={(e) => setPlateDigits(e.target.value)}
                    disabled={noPlate}
                    required={!noPlate}
                  />
                </div>

                <div className="form-group">
                  <label>Vehicle Make / Model</label>
                  <input
                    type="text"
                    value={vehicleModel}
                    onChange={(e) => setVehicleModel(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Assign Tow Truck</label>
                  <select value={assignedTruckId} onChange={(e) => setAssignedTruckId(Number(e.target.value))}>
                    {dashboard?.trucks.map((t) => (
                      <option key={t.truckId} value={t.truckId}>
                        {t.truckCode} ({t.licensePlate}) — {t.fleetStatus}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label>Pickup Breakdown Location</label>
                  <input
                    type="text"
                    value={pickupAddress}
                    onChange={(e) => setPickupAddress(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Destination Garage / Dropoff</label>
                  <input
                    type="text"
                    value={destAddress}
                    onChange={(e) => setDestAddress(e.target.value)}
                    required
                  />
                </div>

                <div className="form-group">
                  <label>Pickup Lat / Lng</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input type="number" step="0.0001" value={pickupLat} onChange={(e) => setPickupLat(e.target.value)} />
                    <input type="number" step="0.0001" value={pickupLng} onChange={(e) => setPickupLng(e.target.value)} />
                  </div>
                </div>

                <div className="form-group">
                  <label>Dropoff Lat / Lng</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input type="number" step="0.0001" value={destLat} onChange={(e) => setDestLat(e.target.value)} />
                    <input type="number" step="0.0001" value={destLng} onChange={(e) => setDestLng(e.target.value)} />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 14 }}>
                <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={hasInsurance}
                    onChange={(e) => setHasInsurance(e.target.checked)}
                  />
                  Covered by Insurance Policy
                </label>
                <label style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={autoApprove}
                    onChange={(e) => setAutoApprove(e.target.checked)}
                  />
                  Immediately Approve &amp; Dispatch Inside Transaction (<span className="mono">usp_ApproveAndDispatchTow</span>)
                </label>
              </div>

              <button type="submit" className="btn btn-success">
                🚀 Create Tow Ticket {autoApprove ? '& Dispatch Now' : '(Save as Draft)'}
              </button>
            </form>
          </div>

          <div className="card">
            <div className="card-title">
              <span>🛡️ Selected Policy Sequential Quota Tiers (<span className="mono">dbo.PolicyQuotaTiers</span>)</span>
            </div>
            {selectedPolicyObj && (
              <>
                <div style={{ fontSize: '0.85rem', marginBottom: 12, color: 'var(--text-muted)' }}>
                  Policy <b>{selectedPolicyObj.policyNumber}</b> · Provider: <b>{selectedPolicyObj.providerName}</b> ·
                  Expires: <b>{selectedPolicyObj.expirationDate}</b> · Status:{' '}
                  <span className="badge badge-Approved">{selectedPolicyObj.policyStatus}</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Seq</th>
                        <th>Coverage Type</th>
                        <th>Allowed</th>
                        <th>Used</th>
                        <th>Remaining</th>
                        <th>Max KM</th>
                        <th>Cooldown Days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedPolicyObj.tiers.map((qt) => (
                        <tr key={qt.quotaTierId}>
                          <td className="mono">#{qt.tierSequence}</td>
                          <td><b>{qt.coverageType}</b></td>
                          <td>{qt.allowedTows}</td>
                          <td>{qt.usedTows}</td>
                          <td>
                            <span className={`badge ${qt.remainingTows > 0 ? 'badge-Done' : 'badge-Rejected'}`}>
                              {qt.remainingTows} left
                            </span>
                          </td>
                          <td>{qt.maxDistanceKm} KM</td>
                          <td>{qt.minIntervalDays} days</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 3: DISPATCH BOARD, LIFECYCLE & TRIGGER IMMUTABILITY LAB
      ===================================================================== */}
      {activeTab === 'board' && (
        <div>
          {triggerTestResult && (
            <div className={`banner ${triggerTestResult.blockedByTrigger ? 'banner-err' : 'banner-ok'}`}>
              <div>
                <b>SQL Server Trigger Test on {triggerTestResult.requestNumber} [{triggerTestResult.status}]:</b>
              </div>
              <div className="mono" style={{ marginTop: 4 }}>
                {triggerTestResult.blockedByTrigger
                  ? `Blocked by dbo.trg_TowRequests_ImmutabilityAndAudit (SQL Error ${triggerTestResult.sqlErrorNumber}): ${triggerTestResult.triggerMessage}`
                  : triggerTestResult.message}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-title">
              <span>📋 Operational Tow Requests &amp; Lifecycle State Machine</span>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Finalized states (<span className="mono">Done</span>, <span className="mono">UnableToLoad</span>,{' '}
                <span className="mono">Rejected</span>) are locked by SQL Trigger{' '}
                <span className="mono">trg_TowRequests_ImmutabilityAndAudit</span>
              </span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticket #</th>
                    <th>Customer &amp; Plate</th>
                    <th>Issue &amp; Policy</th>
                    <th>Truck &amp; Seq</th>
                    <th>Distance / Overage</th>
                    <th>Status</th>
                    <th>Lifecycle Actions / Trigger Test</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard?.recentRequests.map((r) => {
                    const isFinalized = ['Done', 'UnableToLoad', 'Rejected'].includes(r.status);
                    return (
                      <tr key={r.towRequestId}>
                        <td className="mono">
                          <b>{r.requestNumber}</b>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>RowVer: {r.rowVerHex}</div>
                        </td>
                        <td>
                          <b>{r.vehiclePlate}</b> ({r.vehicleModel})
                          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                            {r.customerName} · {r.callerPhone}
                          </div>
                        </td>
                        <td>
                          <b>{r.issueType}</b>
                          <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                            {r.policyNumber || 'Ad-Hoc (No Policy)'}
                          </div>
                        </td>
                        <td>
                          {r.truckCode ? (
                            <>
                              <b>{r.truckCode}</b> (Seq {r.truckPrioritySequence})
                            </>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>Unassigned</span>
                          )}
                        </td>
                        <td>
                          {r.actualDistanceKm} KM (Allow: {r.allowedDistanceKm} KM)
                          {r.overageAmount > 0 && (
                            <div style={{ color: '#fbbf24', fontWeight: 700 }}>
                              +${r.overageAmount} ({r.overageKm} KM excess)
                            </div>
                          )}
                        </td>
                        <td>
                          <span className={`badge badge-${r.status}`}>{r.status}</span>
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {r.status === 'Draft' && (
                              <>
                                <select
                                  style={{ background: '#0b1120', color: '#fff', border: '1px solid #334155', borderRadius: 6, padding: '4px 6px', fontSize: '0.76rem' }}
                                  value={dispatchTruckChoice[r.towRequestId] || 3}
                                  onChange={(e) =>
                                    setDispatchTruckChoice({
                                      ...dispatchTruckChoice,
                                      [r.towRequestId]: Number(e.target.value),
                                    })
                                  }
                                >
                                  {dashboard.trucks
                                    .filter((t) => t.fleetStatus !== 'OffDuty')
                                    .map((t) => (
                                      <option key={t.truckId} value={t.truckId}>
                                        {t.truckCode}
                                      </option>
                                    ))}
                                </select>
                                <button
                                  className="btn btn-sm btn-primary"
                                  onClick={() => handleDispatchDraft(r.towRequestId)}
                                >
                                  Approve &amp; Dispatch
                                </button>
                                <button
                                  className="btn btn-sm btn-danger"
                                  onClick={() => handleStatusChange(r.towRequestId, 'Rejected')}
                                >
                                  Reject
                                </button>
                              </>
                            )}

                            {r.status === 'Approved' && (
                              <>
                                <button
                                  className="btn btn-sm btn-purple"
                                  onClick={() => handleStatusChange(r.towRequestId, 'InProgress')}
                                >
                                  Start Towing
                                </button>
                                <button
                                  className="btn btn-sm btn-warning"
                                  onClick={() => handleStatusChange(r.towRequestId, 'UnableToLoad')}
                                >
                                  Unable to Load
                                </button>
                              </>
                            )}

                            {r.status === 'InProgress' && (
                              <>
                                <button
                                  className="btn btn-sm btn-success"
                                  onClick={() => handleStatusChange(r.towRequestId, 'Done', r.overageAmount)}
                                >
                                  Complete &amp; Bill
                                </button>
                                <button
                                  className="btn btn-sm btn-warning"
                                  onClick={() => handleStatusChange(r.towRequestId, 'UnableToLoad')}
                                >
                                  Unable to Load
                                </button>
                              </>
                            )}

                            {isFinalized && (
                              <button
                                className="btn btn-sm btn-outline"
                                onClick={() => handleTestImmutabilityTrigger(r)}
                                title="Attempts to UPDATE this finalized ticket to Draft — blocked by SQL Trigger!"
                              >
                                🔒 Test Trigger Lock
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Trigger Audit Trail Table */}
          <div className="card">
            <div className="card-title">
              <span>📜 Automatic Trigger Audit Trail (<span className="mono">dbo.TowAuditLogs</span>)</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Audit ID</th>
                    <th>Ticket #</th>
                    <th>Old Status</th>
                    <th>New Status</th>
                    <th>Action Note</th>
                    <th>SQL Login (<span className="mono">SUSER_SNAME()</span>)</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard?.auditLogs.map((a) => (
                    <tr key={a.auditId}>
                      <td className="mono">#{a.auditId}</td>
                      <td className="mono"><b>{a.requestNumber}</b></td>
                      <td>{a.oldStatus}</td>
                      <td>
                        <span className={`badge badge-${a.newStatus}`}>{a.newStatus}</span>
                      </td>
                      <td>{a.actionNote}</td>
                      <td className="mono">{a.changedBy}</td>
                      <td className="mono">{a.changedAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 4: CONCURRENCY & LIVE ATTACK LAB (UPDLOCK + ROWVERSION)
      ===================================================================== */}
      {activeTab === 'concurrency' && (
        <div className="grid-2">
          {/* Experiment 1: Pessimistic Concurrency (2 Dispatchers Racing for Last Accident Tow) */}
          <div className="card">
            <div className="card-title">
              <span>⚡ 1. Pessimistic Concurrency: 2-Dispatcher Quota Race (<span className="mono">UPDLOCK</span>)</span>
            </div>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', marginBottom: 14 }}>
              Policy <span className="mono">POL-2026-ACC-LAST1</span> has <b>only 1 Accident Tow remaining</b> (Allowed = 2,
              Used = 1). Clicking the button below fires <b>two parallel C# connections at the same millisecond</b>{' '}
              calling <span className="mono">EXEC dbo.usp_ApproveAndDispatchTow</span>. Inside{' '}
              <span className="mono">BEGIN TRAN ... TRY...CATCH</span>, Session 1 acquires{' '}
              <span className="mono">WITH (UPDLOCK, ROWLOCK)</span> on the policy, consumes the last tow, and commits;
              Session 2 unblocks, sees <span className="mono">0 remaining</span>, and rolls back cleanly!
            </p>

            <button
              className="btn btn-primary"
              onClick={handleRunRaceSimulation}
              disabled={raceRunning}
              style={{ marginBottom: 16 }}
            >
              {raceRunning
                ? '⏳ Running Parallel SQL Transactions (350ms UPDLOCK hold)...'
                : '🚀 Run 2-User Simultaneous Dispatch Race Now'}
            </button>

            {raceResult && (
              <div>
                <div className="banner banner-ok">
                  <div>
                    <b>Policy Tested:</b> {raceResult.policyTested} | <b>Mechanism:</b>{' '}
                    <span className="mono">{raceResult.concurrencyMechanism}</span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    Initial Remaining: <b>{raceResult.initialAccidentTowsRemaining}</b> → Final Used:{' '}
                    <b>
                      {raceResult.finalUsedTows} / {raceResult.finalAllowedTows}
                    </b>{' '}
                    (Remaining: <b>{raceResult.finalRemainingTows}</b> — Double-spend prevented!)
                  </div>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Concurrent Session</th>
                        <th>Ticket</th>
                        <th>Start → End (ms)</th>
                        <th>Transaction Outcome</th>
                        <th>SQL Server Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {raceResult.sessionResults.map((sr, i) => (
                        <tr key={i}>
                          <td><b>{sr.dispatcher}</b></td>
                          <td className="mono">{sr.requestNumber}</td>
                          <td className="mono">
                            {sr.startedAtMs}ms → {sr.finishedAtMs}ms ({sr.durationMs}ms)
                          </td>
                          <td>
                            <span
                              className={`badge ${
                                sr.outcome === 'COMMITTED' ? 'badge-Done' : 'badge-Rejected'
                              }`}
                            >
                              {sr.outcome}
                            </span>
                          </td>
                          <td style={{ fontSize: '0.78rem' }}>{sr.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Experiment 2: Optimistic Concurrency (ROWVERSION Conflict) */}
          <div className="card">
            <div className="card-title">
              <span>🛡️ 2. Optimistic Concurrency: Lost-Update Prevention (<span className="mono">ROWVERSION</span>)</span>
            </div>
            <p style={{ fontSize: '0.84rem', color: 'var(--text-muted)', marginBottom: 14 }}>
              Every table includes a <span className="mono">RowVer ROWVERSION</span> column. When two dispatchers open
              the same Draft ticket, both read the same <span className="mono">RowVer</span> binary token. When
              Dispatcher #1 saves, SQL Server automatically increments <span className="mono">RowVer</span>. When
              Dispatcher #2 tries to save with the stale <span className="mono">RowVer</span>,{' '}
              <span className="mono">dbo.usp_UpdateDraftTowOptimistic</span> checks{' '}
              <span className="mono">WHERE TowRequestId = @Id AND RowVer = @ExpectedRowVer</span>, detects{' '}
              <span className="mono">@@ROWCOUNT = 0</span>, and raises Error 50020!
            </p>

            <button className="btn btn-purple" onClick={handleRunOptimisticDemo} style={{ marginBottom: 16 }}>
              🧪 Simulate Stale ROWVERSION Edit Conflict (2 Dispatchers)
            </button>

            {optimisticResult && (
              <div>
                <div className="banner banner-err">
                  <div>
                    <b>Ticket Tested:</b> <span className="mono">{optimisticResult.ticket}</span> |{' '}
                    <b>Initial RowVer Token Read by Both Tabs:</b>{' '}
                    <span className="mono">{optimisticResult.initialRowVer}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    ✅ <b>Dispatcher #1 Save:</b> {optimisticResult.user1Result.message}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    🛑 <b>Dispatcher #2 Save (Stale RowVer):</b> SQL Error{' '}
                    {optimisticResult.user2Result.sqlErrorNumber} — {optimisticResult.user2Result.error}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 5: >120,000-ROW PERFORMANCE & SQL INJECTION LAB
      ===================================================================== */}
      {activeTab === 'performance' && (
        <div>
          <div className="card">
            <div className="card-title">
              <span>🚀 High-Speed Query Lab on 120,007-Row Table (<span className="mono">dbo.TowRequests</span>)</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    setPerfMode('plate');
                    setPerfPlate("' OR 1=1 --");
                    runPerformanceQuery('plate', "' OR 1=1 --");
                  }}
                >
                  🛡️ Test SQL Injection Attack: &apos; OR 1=1 --
                </button>
                <button
                  className="btn btn-sm btn-outline"
                  onClick={() => {
                    setPerfMode('plate');
                    setPerfPlate('M 100001');
                    runPerformanceQuery('plate', 'M 100001');
                  }}
                >
                  🔍 Lookup Plate &apos;M 100001&apos;
                </button>
              </div>
            </div>

            <div className="form-grid" style={{ alignItems: 'end' }}>
              <div className="form-group">
                <label>Select Key Query &amp; Covering Index</label>
                <select value={perfMode} onChange={(e) => setPerfMode(e.target.value)}>
                  <option value="status_date">
                    Key Query 2: Status + SARGable Date Range (IX_TowRequests_Status_CreatedAt_Covering)
                  </option>
                  <option value="policy">
                    Key Query 1: Policy + IssueType Cooldown History (IX_TowRequests_Policy_Issue_CreatedAt)
                  </option>
                  <option value="plate">
                    Key Query 3: Exact License Plate Search (IX_TowRequests_VehiclePlate_CreatedAt)
                  </option>
                </select>
              </div>

              {perfMode === 'status_date' && (
                <>
                  <div className="form-group">
                    <label>Status</label>
                    <select value={perfStatus} onChange={(e) => setPerfStatus(e.target.value)}>
                      <option value="Done">Done</option>
                      <option value="UnableToLoad">UnableToLoad</option>
                      <option value="Rejected">Rejected</option>
                      <option value="InProgress">InProgress</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Start Date (&gt;= @StartDate)</label>
                    <input type="date" value={perfStartDate} onChange={(e) => setPerfStartDate(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>End Date (&lt; @EndDate)</label>
                    <input type="date" value={perfEndDate} onChange={(e) => setPerfEndDate(e.target.value)} />
                  </div>
                </>
              )}

              {perfMode === 'policy' && (
                <>
                  <div className="form-group">
                    <label>Policy ID (1..150)</label>
                    <input
                      type="number"
                      value={perfPolicyId}
                      onChange={(e) => setPerfPolicyId(Number(e.target.value))}
                    />
                  </div>
                  <div className="form-group">
                    <label>Issue Type</label>
                    <select value={perfIssueType} onChange={(e) => setPerfIssueType(e.target.value)}>
                      <option value="Mechanical">Mechanical</option>
                      <option value="Accident">Accident</option>
                      <option value="Battery">Battery</option>
                      <option value="Tire">Tire</option>
                    </select>
                  </div>
                </>
              )}

              {perfMode === 'plate' && (
                <div className="form-group">
                  <label>Vehicle Plate (Parameterized @VehiclePlate)</label>
                  <input type="text" value={perfPlate} onChange={(e) => setPerfPlate(e.target.value)} />
                </div>
              )}

              <div className="form-group">
                <button className="btn btn-primary" onClick={() => runPerformanceQuery()} disabled={perfLoading}>
                  {perfLoading ? 'Running...' : '⚡ Execute Parameterized Query'}
                </button>
              </div>
            </div>

            {perfResult && (
              <>
                <div className="banner banner-ok" style={{ marginTop: 12 }}>
                  <div>
                    ⏱️ <b>SQL Execution Time:</b> <span className="mono">{perfResult.elapsedMs} ms</span> |{' '}
                    <b>Rows Returned:</b> {perfResult.rowCountReturned} (from 120,007 total rows)
                  </div>
                  <div style={{ marginTop: 4 }}>
                    📌 <b>Covering Index Used:</b> <span className="mono">{perfResult.indexUsed}</span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    🎯 <b>Plan Characteristics:</b> {perfResult.planCharacteristics}
                  </div>
                  {perfResult.statisticsIo && (
                    <div className="mono" style={{ marginTop: 4, fontSize: '0.78rem', color: '#fde68a' }}>
                      📊 STATISTICS IO: {perfResult.statisticsIo}
                    </div>
                  )}
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Request #</th>
                        <th>Vehicle Plate</th>
                        <th>Vehicle Model</th>
                        <th>Issue Type</th>
                        <th>Status</th>
                        <th>Actual KM</th>
                        <th>Allowed KM</th>
                        <th>Overage ($)</th>
                        <th>Created At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perfResult.rows.length === 0 ? (
                        <tr>
                          <td colSpan={10} style={{ textAlign: 'center', padding: 20, color: 'var(--text-muted)' }}>
                            0 matching rows found — if you tested <b>&apos; OR 1=1 --</b>, parameterized{' '}
                            <span className="mono">SqlParameter(&quot;@VehiclePlate&quot;)</span> treated it as a literal
                            plate string and returned 0 rows safely!
                          </td>
                        </tr>
                      ) : (
                        perfResult.rows.map((r) => (
                          <tr key={r.towRequestId}>
                            <td className="mono">{r.towRequestId}</td>
                            <td className="mono"><b>{r.requestNumber}</b></td>
                            <td className="mono">{r.vehiclePlate}</td>
                            <td>{r.vehicleModel}</td>
                            <td>{r.issueType}</td>
                            <td>
                              <span className={`badge badge-${r.status}`}>{r.status}</span>
                            </td>
                            <td>{r.actualDistanceKm} KM</td>
                            <td>{r.allowedDistanceKm} KM</td>
                            <td>${r.overageAmount}</td>
                            <td className="mono">{r.createdAt}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
