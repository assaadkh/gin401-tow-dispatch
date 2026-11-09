import React, { useState, useEffect, useRef } from 'react';
import { GoogleCadMap, GoogleLocationPickerMap } from './GoogleMapEngine';

const API_BASE = '/api';

// Default center: Beirut, Lebanon
const BEIRUT_LAT = 33.8938;
const BEIRUT_LNG = 35.5018;

const KANBAN_STAGES = [
  { key: 'Draft', label: '1. Draft', color: '#64748b' },
  { key: 'PendingInsurance', label: '2. Pending Insurance', color: '#f59e0b' },
  { key: 'Approved', label: '3. Approved', color: '#3b82f6' },
  { key: 'InProgress', label: '4. In Progress', color: '#8b5cf6' },
  { key: 'UnableToLoad', label: '5. Unable to Load (Locked)', color: '#f97316' },
  { key: 'Done', label: '6. Done (Locked)', color: '#10b981' },
  { key: 'Rejected', label: '7. Rejected (Locked)', color: '#ef4444' }
];

export default function App() {
  const [activeTab, setActiveTab] = useState('map'); // 'map' | 'intake' | 'queue' | 'concurrency' | 'performance'
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [policyWarningModal, setPolicyWarningModal] = useState(null);
  const [incomingCallModal, setIncomingCallModal] = useState(null);

  // Call Intake & Eligibility Form State (Empty by default — not pre-filled!)
  const [selectedPolicyId, setSelectedPolicyId] = useState(1);
  const [selectedIncidentType, setSelectedIncidentType] = useState('Mechanical');
  const [eligibility, setEligibility] = useState(null);
  const [intakeForm, setIntakeForm] = useState({
    callerName: '',
    callerPhone: '',
    vehicleDesc: '',
    noPlate: false,
    plateCodeId: 2, // M
    plateDigits: '',
    pickupAddress: '',
    pickupLat: BEIRUT_LAT,
    pickupLng: BEIRUT_LNG,
    dropoffAddress: '',
    dropoffLat: 33.8940,
    dropoffLng: 35.5520,
    isOutsourced: false,
    subcontractorName: '',
    subcontractorFee: 0,
    notes: ''
  });

  // Built-in Google Maps Location Picker Modal State (Beirut default)
  const [locationPicker, setLocationPicker] = useState({
    open: false,
    target: 'pickup', // 'pickup' | 'dropoff'
    lat: BEIRUT_LAT,
    lng: BEIRUT_LNG,
    resolvedPlaceName: 'Beirut, Lebanon',
    searchQuery: '',
    searchResults: [],
    searching: false
  });

  // Plate Code Settings Modal State
  const [newPlateLetter, setNewPlateLetter] = useState('');
  const [newPlateCategory, setNewPlateCategory] = useState('Special / Custom Plate');
  const [showPlateModal, setShowPlateModal] = useState(false);

  // Policy Quota Tier Editor State
  const [editingTier, setEditingTier] = useState(null);
  const [newTierForm, setNewTierForm] = useState({
    tierSequence: 3,
    coverageType: 'All',
    allowedTows: 2,
    usedTows: 0,
    maxDistanceKm: 40,
    minIntervalDays: 7
  });
  const [showTierEditor, setShowTierEditor] = useState(false);

  // Live Google Maps CAD Drawer & State
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState('trucks'); // 'trucks' | 'jobs'
  const [trafficEnabled, setTrafficEnabled] = useState(false);
  const [selectedMapTruckId, setSelectedMapTruckId] = useState(null);
  const [selectedMapJobId, setSelectedMapJobId] = useState(null);
  const [stopQueueTruckId, setStopQueueTruckId] = useState(null);
  const [mapFlyToTarget, setMapFlyToTarget] = useState(null);
  const drawerCardRefs = useRef({});

  // Queue & Kanban View State
  const [queueViewMode, setQueueViewMode] = useState('kanban'); // 'kanban' | 'table' | 'payroll'
  const [selectedTruckByReq, setSelectedTruckByReq] = useState({});

  // Concurrency Lab State
  const [concurrencyResult, setConcurrencyResult] = useState(null);
  const [concurrencyRunning, setConcurrencyRunning] = useState(false);
  const [optimisticNote, setOptimisticNote] = useState('Updated pickup note: customer moved 50m ahead.');
  const [optimisticResult, setOptimisticResult] = useState(null);

  // Performance & Security Lab State
  const [perfMode, setPerfMode] = useState('date_status'); // 'date_status' | 'policy' | 'plate'
  const [perfStatus, setPerfStatus] = useState('Done');
  const [perfStart, setPerfStart] = useState('2026-01-01');
  const [perfEnd, setPerfEnd] = useState('2026-12-31');
  const [perfPlate, setPerfPlate] = useState('M 100001');
  const [perfResult, setPerfResult] = useState(null);
  const [perfLoading, setPerfLoading] = useState(false);

  const showToast = (type, title, message) => {
    setToast({ type, title, message });
    setTimeout(() => setToast(null), 6500);
  };

  const fetchDashboard = async () => {
    try {
      const res = await fetch(`${API_BASE}/dashboard`);
      const data = await res.json();
      setDashboard(data);
    } catch (err) {
      showToast('error', 'Backend Connection Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, []);

  // Check Policy Eligibility whenever policy, incident type, or coordinates change
  const checkEligibility = async (showPopupOnViolation = false) => {
    if (!selectedPolicyId) return;
    try {
      const url = `${API_BASE}/policies/${selectedPolicyId}/check-eligibility?issueType=${encodeURIComponent(
        selectedIncidentType
      )}&lat1=${intakeForm.pickupLat}&lng1=${intakeForm.pickupLng}&lat2=${intakeForm.dropoffLat}&lng2=${intakeForm.dropoffLng}`;
      const res = await fetch(url);
      const data = await res.json();
      setEligibility(data);

      if (showPopupOnViolation && data) {
        const policyObj = dashboard?.policies?.find(p => p.policyId === Number(selectedPolicyId));
        const policyLabel = policyObj
          ? `${policyObj.policyNumber} (${policyObj.customerName})`
          : `Policy #${selectedPolicyId}`;

        if (
          (selectedIncidentType === 'Accident' || selectedIncidentType === 'Winch') &&
          data.remainingCategoryTows <= 0
        ) {
          setPolicyWarningModal({
            title: '🚨 Accident Tow Not Allowed',
            message: `The insurance policy '${policyLabel}' does not allow any accidental tows anymore! Remaining accident tows: 0. Direct customer billing is required.`,
            reason: data.statusBanner
          });
        } else if (!data.isEligible) {
          setPolicyWarningModal({
            title: '⚠️ Policy Quota / Cooldown Restriction',
            message: data.statusBanner,
            reason: `Days since last tow: ${data.daysSinceLastTow ?? 'N/A'} days | Min required cooldown interval: ${data.requiredCooldownDays} days`
          });
        }
      }
    } catch (err) {
      console.error('Eligibility check failed:', err);
    }
  };

  useEffect(() => {
    checkEligibility(false);
  }, [
    selectedPolicyId,
    selectedIncidentType,
    intakeForm.pickupLat,
    intakeForm.pickupLng,
    intakeForm.dropoffLat,
    intakeForm.dropoffLng
  ]);

  // Reverse Geocoding Helper (BigDataCloud + Nominatim fallback - never raw coordinates!)
  const reverseGeocodeLocality = async (lat, lng) => {
    try {
      const res = await fetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
      );
      if (res.ok) {
        const data = await res.json();
        const parts = [
          data.locality || data.city || data.town,
          data.principalSubdivision,
          data.countryName
        ].filter(Boolean);
        const unique = [...new Set(parts)];
        if (unique.length > 0) return unique.join(', ');
      }
    } catch (e) {
      // fallback to Nominatim
    }
    try {
      const nom = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`
      );
      if (nom.ok) {
        const d = await nom.json();
        if (d.display_name) {
          return d.display_name.split(',').slice(0, 3).join(',').trim();
        }
      }
    } catch (e) {
      // fallback
    }
    return 'Beirut, Mount Lebanon, Lebanon';
  };

  // Open Built-in Location Picker Modal (Beirut default if empty)
  const openLocationPickerModal = async target => {
    const isPickup = target === 'pickup';
    const initLat = isPickup
      ? intakeForm.pickupLat || BEIRUT_LAT
      : intakeForm.dropoffLat || BEIRUT_LAT;
    const initLng = isPickup
      ? intakeForm.pickupLng || BEIRUT_LNG
      : intakeForm.dropoffLng || BEIRUT_LNG;
    const placeName = await reverseGeocodeLocality(initLat, initLng);

    setLocationPicker({
      open: true,
      target,
      lat: initLat,
      lng: initLng,
      resolvedPlaceName: placeName,
      searchQuery: '',
      searchResults: [],
      searching: false
    });
  };

  // Handle pin drop/drag in Location Picker Modal
  const handlePickerCoordinatesChange = async (lat, lng) => {
    const cleanLat = Number(lat.toFixed(6));
    const cleanLng = Number(lng.toFixed(6));
    const placeName = await reverseGeocodeLocality(cleanLat, cleanLng);
    setLocationPicker(prev => ({
      ...prev,
      lat: cleanLat,
      lng: cleanLng,
      resolvedPlaceName: placeName
    }));
  };

  // Search Places inside Location Picker Modal (Photon + Nominatim fallback)
  const handleLocationSearch = async query => {
    setLocationPicker(prev => ({ ...prev, searchQuery: query }));
    if (!query || query.trim().length < 2) {
      setLocationPicker(prev => ({ ...prev, searchResults: [] }));
      return;
    }

    setLocationPicker(prev => ({ ...prev, searching: true }));
    try {
      const photonRes = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(
          query + ' Lebanon'
        )}&lat=${BEIRUT_LAT}&lon=${BEIRUT_LNG}&limit=5`
      );
      if (photonRes.ok) {
        const photonData = await photonRes.json();
        const items = (photonData.features || []).map(f => {
          const p = f.properties || {};
          const labelParts = [
            p.name,
            p.street,
            p.city || p.locality || p.district,
            p.country
          ].filter(Boolean);
          return {
            name: [...new Set(labelParts)].join(', '),
            lat: Number(f.geometry.coordinates[1].toFixed(6)),
            lng: Number(f.geometry.coordinates[0].toFixed(6))
          };
        });
        if (items.length > 0) {
          setLocationPicker(prev => ({ ...prev, searchResults: items, searching: false }));
          return;
        }
      }
    } catch (e) {
      // fallback to Nominatim
    }

    try {
      const nomRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          query + ' Lebanon'
        )}&limit=5`
      );
      if (nomRes.ok) {
        const nomData = await nomRes.json();
        const items = nomData.map(item => ({
          name: item.display_name.split(',').slice(0, 3).join(', '),
          lat: Number(parseFloat(item.lat).toFixed(6)),
          lng: Number(parseFloat(item.lon).toFixed(6))
        }));
        setLocationPicker(prev => ({ ...prev, searchResults: items, searching: false }));
        return;
      }
    } catch (e) {
      // ignore
    }
    setLocationPicker(prev => ({ ...prev, searching: false }));
  };

  // Select Autocomplete Result in Location Picker
  const selectAutocompleteLocation = item => {
    setLocationPicker(prev => ({
      ...prev,
      lat: item.lat,
      lng: item.lng,
      resolvedPlaceName: item.name,
      searchQuery: item.name,
      searchResults: []
    }));

    if (locationPicker.target === 'pickup') {
      setIntakeForm(prev => ({
        ...prev,
        pickupAddress: item.name,
        pickupLat: item.lat,
        pickupLng: item.lng
      }));
    } else {
      setIntakeForm(prev => ({
        ...prev,
        dropoffAddress: item.name,
        dropoffLat: item.lat,
        dropoffLng: item.lng
      }));
    }
  };

  // Confirm Pin in Location Picker Modal
  // Rule: Preserve custom user-typed name if present; only fill resolved locality name if input is empty!
  const confirmPickedLocation = () => {
    const { target, lat, lng, resolvedPlaceName } = locationPicker;
    if (target === 'pickup') {
      setIntakeForm(prev => ({
        ...prev,
        pickupLat: lat,
        pickupLng: lng,
        pickupAddress:
          prev.pickupAddress && prev.pickupAddress.trim().length > 0
            ? prev.pickupAddress
            : resolvedPlaceName
      }));
    } else {
      setIntakeForm(prev => ({
        ...prev,
        dropoffLat: lat,
        dropoffLng: lng,
        dropoffAddress:
          prev.dropoffAddress && prev.dropoffAddress.trim().length > 0
            ? prev.dropoffAddress
            : resolvedPlaceName
      }));
    }
    setLocationPicker(prev => ({ ...prev, open: false }));
  };

  // Incoming Phone Call Pop-up Simulation (Only passes Caller Phone Number — does NOT auto-fill full form!)
  const triggerIncomingCall = () => {
    const samplePhones = [
      '+961-03-111222',
      '+961-70-222333',
      '+961-71-333444',
      '+961-03-444555',
      '+961-76-889900'
    ];
    const pickedPhone = samplePhones[Math.floor(Math.random() * samplePhones.length)];
    setIncomingCallModal({ phone: pickedPhone });
  };

  const acceptIncomingCall = phoneStr => {
    setIntakeForm({
      callerName: '',
      callerPhone: phoneStr,
      vehicleDesc: '',
      noPlate: false,
      plateCodeId: 2,
      plateDigits: '',
      pickupAddress: '',
      pickupLat: BEIRUT_LAT,
      pickupLng: BEIRUT_LNG,
      dropoffAddress: '',
      dropoffLat: 33.8940,
      dropoffLng: 35.5520,
      isOutsourced: false,
      subcontractorName: '',
      subcontractorFee: 0,
      notes: ''
    });
    setIncomingCallModal(null);
    setActiveTab('intake');
    showToast(
      'success',
      '📞 Incoming Call Answered',
      `Caller phone ${phoneStr} connected. Please enter the caller's details and breakdown location.`
    );
  };

  // Submit Call Intake
  const handleCreateTowRequest = async e => {
    e.preventDefault();
    if (!intakeForm.noPlate && (!intakeForm.plateCodeId || !intakeForm.plateDigits.trim())) {
      showToast(
        'error',
        'Plate Letter & Digits Required',
        'Please select a Lebanese Plate Letter and enter plate digits, or check "No Plate (Unregistered)".'
      );
      return;
    }

    const policyObj = dashboard?.policies?.find(p => p.policyId === Number(selectedPolicyId));

    try {
      const res = await fetch(`${API_BASE}/tow-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: policyObj?.customerId || 1,
          callerPhone: intakeForm.callerPhone,
          plateCodeId: intakeForm.noPlate ? null : Number(intakeForm.plateCodeId),
          plateDigits: intakeForm.noPlate ? null : intakeForm.plateDigits.trim(),
          noPlate: intakeForm.noPlate,
          vehicleModel: intakeForm.vehicleDesc,
          issueType: selectedIncidentType,
          issueNotes: intakeForm.notes,
          pickupAddress: intakeForm.pickupAddress,
          pickupLat: Number(intakeForm.pickupLat),
          pickupLng: Number(intakeForm.pickupLng),
          destinationAddress: intakeForm.dropoffAddress,
          destinationLat: Number(intakeForm.dropoffLat),
          destinationLng: Number(intakeForm.dropoffLng),
          hasInsurance: true,
          policyId: Number(selectedPolicyId),
          isOutsourced: intakeForm.isOutsourced,
          subcontractorName: intakeForm.isOutsourced ? intakeForm.subcontractorName : null,
          subcontractorFee: intakeForm.isOutsourced ? Number(intakeForm.subcontractorFee) : 0,
          assignedTruckId: null,
          autoApprove: false
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create tow request');

      showToast(
        'success',
        `Created ${data.data?.requestNumber || 'Ticket'} (${data.data?.status || 'Draft'})`,
        data.message
      );
      await fetchDashboard();
      setActiveTab('queue');
    } catch (err) {
      showToast('error', 'Failed to Create Request', err.message);
    }
  };

  // Add New Plate Letter
  const handleAddPlateCode = async e => {
    e.preventDefault();
    if (!newPlateLetter.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/plate-codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: newPlateLetter.trim().toUpperCase(),
          regionDescription: newPlateCategory,
          displaySequence: (dashboard?.plateCodes?.length || 10) + 1
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add plate letter');
      showToast('success', 'Plate Letter Saved', data.message);
      setNewPlateLetter('');
      setShowPlateModal(false);
      await fetchDashboard();
    } catch (err) {
      showToast('error', 'Plate Code Error', err.message);
    }
  };

  // Update Policy Quota Tier
  const handleUpdateTier = async tier => {
    try {
      const res = await fetch(`${API_BASE}/quota-tiers/${tier.quotaTierId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tierSequence: tier.tierSequence,
          coverageType: tier.coverageType,
          allowedTows: tier.allowedTows,
          usedTows: tier.usedTows,
          maxDistanceKm: tier.maxDistanceKm,
          minIntervalDays: tier.minIntervalDays
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update policy quota tier');
      showToast('success', 'Policy Quota Tier Updated', data.message);
      setEditingTier(null);
      await fetchDashboard();
      await checkEligibility(false);
    } catch (err) {
      showToast('error', 'Tier Update Failed', err.message);
    }
  };

  // Add New Sequential Quota Tier to Selected Policy
  const handleAddTier = async e => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/policies/${selectedPolicyId}/tiers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTierForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add quota tier');
      showToast('success', 'Sequential Tier Added', data.message);
      await fetchDashboard();
      await checkEligibility(false);
    } catch (err) {
      showToast('error', 'Add Tier Failed', err.message);
    }
  };

  // Approve & Dispatch to Truck
  const handleDispatchTruck = async towRequestId => {
    const truckId =
      selectedTruckByReq[towRequestId] ||
      dashboard?.trucks?.find(t => t.fleetStatus === 'Available')?.truckId ||
      1;
    try {
      const res = await fetch(`${API_BASE}/tow-requests/${towRequestId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedTruckId: Number(truckId)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Dispatch failed');
      showToast(
        'success',
        `Dispatched ${data.requestNumber || ''}`,
        `Assigned Truck #${data.assignedTruckId} (Stop #${data.truckPrioritySequence})`
      );
      await fetchDashboard();
    } catch (err) {
      showToast('error', 'Dispatch Blocked by SQL Server', err.message);
    }
  };

  // Update Lifecycle Status
  const handleLifecycleChange = async (towRequestId, newStatus) => {
    try {
      const res = await fetch(`${API_BASE}/tow-requests/${towRequestId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newStatus,
          cashCollected: newStatus === 'Done' ? 15.0 : 0.0,
          rejectionReason: newStatus === 'Rejected' ? 'Rejected by Dispatcher' : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Status transition rejected');
      showToast('success', `Status → ${newStatus}`, data.message);
      await fetchDashboard();
    } catch (err) {
      showToast('error', 'SQL Trigger / Lifecycle Error', err.message);
    }
  };

  // Test Immutability Trigger on Locked Ticket
  const handleTestTriggerLock = async towRequestId => {
    try {
      const res = await fetch(
        `${API_BASE}/tow-requests/${towRequestId}/test-immutability-trigger`,
        { method: 'POST' }
      );
      const data = await res.json();
      if (data.blockedByTrigger) {
        showToast(
          'error',
          `🔒 SQL Trigger Blocked Undo (Err ${data.sqlErrorNumber})`,
          data.triggerMessage
        );
      } else {
        showToast('success', 'Trigger Test', data.message);
      }
    } catch (err) {
      showToast('error', 'Trigger Test Error', err.message);
    }
  };

  // Reorder Truck Priority Queue (Earlier / Later)
  const handleReorderQueue = async (truckId, towRequestId, direction) => {
    try {
      const res = await fetch(`${API_BASE}/trucks/${truckId}/reorder-queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ towRequestId, direction })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Queue reorder failed');
      showToast(
        'success',
        'Stop Priority Updated',
        `Reordered job ${direction.toUpperCase()} in truck queue.`
      );
      await fetchDashboard();
    } catch (err) {
      showToast('error', 'Reorder Error', err.message);
    }
  };

  // Concurrency Race Simulator
  const handleSimulateConcurrencyRace = async () => {
    setConcurrencyRunning(true);
    setConcurrencyResult(null);
    try {
      const res = await fetch(`${API_BASE}/concurrency/simulate-race`, {
        method: 'POST'
      });
      const data = await res.json();
      setConcurrencyResult(data);
      await fetchDashboard();
    } catch (err) {
      showToast('error', 'Concurrency Simulation Error', err.message);
    } finally {
      setConcurrencyRunning(false);
    }
  };

  // Optimistic ROWVERSION Update Test
  const handleOptimisticUpdate = async (reqObj, forceStaleToken = false) => {
    try {
      const tokenToSend = forceStaleToken ? '0x0000000000000001' : reqObj.rowVerHex;
      const res = await fetch(`${API_BASE}/tow-requests/${reqObj.towRequestId}/optimistic-edit`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueType: reqObj.issueType,
          issueNotes: optimisticNote,
          expectedRowVerHex: tokenToSend
        })
      });
      const data = await res.json();
      setOptimisticResult({ status: res.status, ok: res.ok, ...data });
      if (res.ok) {
        showToast('success', 'Optimistic Update Succeeded', data.message);
        await fetchDashboard();
      } else {
        showToast('error', 'HTTP 400/409 Optimistic Concurrency Conflict', data.error);
      }
    } catch (err) {
      showToast('error', 'Optimistic Update Error', err.message);
    }
  };

  // >120k Rows Performance Search
  const runPerformanceQuery = async (overrideMode, overridePlate) => {
    setPerfLoading(true);
    const modeVal = overrideMode || perfMode;
    const plateVal = overridePlate !== undefined ? overridePlate : perfPlate;
    try {
      const url = `${API_BASE}/performance/search?mode=${encodeURIComponent(
        modeVal
      )}&status=${encodeURIComponent(perfStatus)}&startDate=${encodeURIComponent(
        perfStart
      )}&endDate=${encodeURIComponent(perfEnd)}&vehiclePlate=${encodeURIComponent(plateVal)}`;
      const res = await fetch(url);
      const data = await res.json();
      setPerfResult(data);
    } catch (err) {
      showToast('error', 'Performance Query Error', err.message);
    } finally {
      setPerfLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'performance' && !perfResult) {
      runPerformanceQuery('date_status', perfPlate);
    }
  }, [activeTab]);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <h2>Connecting to SQL Server (GIN401_TowDispatch)...</h2>
        <p>Verifying 120,000+ rows in dbo.TowRequests &amp; least-privilege role...</p>
      </div>
    );
  }

  const kpis = dashboard?.kpis || {};
  const selectedPolicyObj = dashboard?.policies?.find(p => p.policyId === Number(selectedPolicyId));
  const selectedPolicyTiers = selectedPolicyObj?.tiers || [];
  const ongoingJobs = (dashboard?.recentRequests || []).filter(
    r =>
      r.status === 'Draft' ||
      r.status === 'PendingInsurance' ||
      r.status === 'Approved' ||
      r.status === 'InProgress'
  );

  return (
    <div className="app-shell">
      {/* erp Enterprise Top Navbar (.o_main_navbar) */}
      <header className="o-main-navbar">
        <div className="o-navbar-left">
          <div className="o-app-brand">
            <span>🚨</span>
            <span>Towing &amp; Roadside CAD</span>
            <span className="o-app-brand-badge">GIN401 Enterprise</span>
          </div>

          <nav className="o-menu-sections">
            <button
              className={activeTab === 'map' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => setActiveTab('map')}
            >
              🗺️ Live CAD Map
            </button>
            <button
              className={activeTab === 'queue' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => setActiveTab('queue')}
            >
              📋 Tow Requests (Kanban / List)
            </button>
            <button
              className={activeTab === 'intake' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => setActiveTab('intake')}
            >
              📞 Call Intake &amp; Policy Quotas
            </button>
            <button
              className={activeTab === 'concurrency' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => setActiveTab('concurrency')}
            >
              ⚡ Concurrency Lab
            </button>
            <button
              className={activeTab === 'performance' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => setActiveTab('performance')}
            >
              🚀 &gt;120k Performance Lab
            </button>
          </nav>
        </div>

        <div className="o-navbar-systray">
          <button className="btn-incoming-call" onClick={triggerIncomingCall}>
            📞 Simulate Incoming Call
          </button>
          <div className="o-systray-pill">
            <span>DB Rows:</span>
            <strong>{kpis.totalTowRequests?.toLocaleString()}</strong>
          </div>
          <div className="o-systray-pill">
            <span>SQL User:</span>
            <strong>{kpis.connectedSqlLogin}</strong>
          </div>
        </div>
      </header>

      {/* erp Control Panel & Breadcrumbs (shown on ERP views outside full-screen CAD Map) */}
      {activeTab !== 'map' && (
        <div className="o-control-panel">
          <div className="o-cp-left">
            <div className="o-breadcrumb-title">
              <span>Roadside Assistance</span>
              <span className="muted">/</span>
              <span>
                {activeTab === 'intake' && 'New Call Intake & Policy Quota Evaluation'}
                {activeTab === 'queue' && 'Tow Requests & Driver Payroll'}
                {activeTab === 'concurrency' && 'SQL Server Concurrency & Locking Lab'}
                {activeTab === 'performance' && '120,000+ Rows Indexing & SQLi Lab'}
              </span>
            </div>
            {activeTab !== 'intake' && (
              <button
                className="btn-erp-primary"
                onClick={() => setActiveTab('intake')}
              >
                ➕ New Tow Request
              </button>
            )}
          </div>

          <div className="o-cp-right">
            <div className="o-kpi-strip">
              <div className="o-kpi-chip">
                Active Queue:
                <strong>{(kpis.activeDispatches || 0) + (kpis.pendingDrafts || 0)}</strong>
              </div>
              <div className="o-kpi-chip">
                Available Trucks:
                <strong>{kpis.availableTrucks}</strong>
              </div>
              <div className="o-kpi-chip">
                Active Policies:
                <strong>{kpis.activePolicies?.toLocaleString()}</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          <div>
            <strong>{toast.title}</strong>
            <p>{toast.message}</p>
          </div>
          <button onClick={() => setToast(null)}>✕</button>
        </div>
      )}

      {/* Incoming Phone Call Modal (Only passes Caller Phone Number) */}
      {incomingCallModal && (
        <div className="modal-backdrop">
          <div className="modal-box incoming-call-modal">
            <div className="incoming-call-ring-badge">📲 INCOMING EMERGENCY CALL</div>
            <h3>Incoming Caller Number</h3>
            <div className="form-row" style={{ marginTop: '8px' }}>
              <label>Caller Phone Number</label>
              <input
                type="text"
                value={incomingCallModal.phone}
                onChange={e =>
                  setIncomingCallModal({ ...incomingCallModal, phone: e.target.value })
                }
              />
            </div>
            <p className="muted" style={{ marginTop: '6px' }}>
              Answering will open Call Intake with only the caller phone number filled.
            </p>
            <div className="modal-actions">
              <button
                className="btn-primary"
                onClick={() => acceptIncomingCall(incomingCallModal.phone)}
              >
                📞 Answer Call
              </button>
              <button className="btn-secondary" onClick={() => setIncomingCallModal(null)}>
                Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Policy Quota / Accident Tow Warning Modal */}
      {policyWarningModal && (
        <div className="modal-backdrop">
          <div className="modal-box warning-modal">
            <h3>{policyWarningModal.title}</h3>
            <p className="warning-modal-text">{policyWarningModal.message}</p>
            {policyWarningModal.reason && (
              <div className="warning-modal-sub">{policyWarningModal.reason}</div>
            )}
            <div className="modal-actions">
              <button className="btn-primary" onClick={() => setPolicyWarningModal(null)}>
                Understood (Proceed as Pending / Direct Billing)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Built-in Google Maps Location Picker Modal (Beirut default, Google-style search bar, draggable pin) */}
      {locationPicker.open && (
        <div className="modal-backdrop">
          <div className="modal-box location-picker-modal">
            <div className="modal-header-row">
              <h3>
                {locationPicker.target === 'pickup'
                  ? '📍 Pick Breakdown / Pickup Location'
                  : '🏁 Pick Destination / Dropoff Location'}
              </h3>
              <button
                className="btn-close"
                onClick={() => setLocationPicker(prev => ({ ...prev, open: false }))}
              >
                ✕
              </button>
            </div>

            {/* Floating Google Maps-style Search Bar with Autocomplete */}
            <div className="map-search-bar-wrap">
              <input
                type="text"
                className="map-search-input"
                placeholder="🔍 Search place, street, or landmark in Lebanon (e.g. Jbeil, Hamra, Jounieh)..."
                value={locationPicker.searchQuery}
                onChange={e => handleLocationSearch(e.target.value)}
              />
              {locationPicker.searchResults.length > 0 && (
                <div className="map-search-dropdown">
                  {locationPicker.searchResults.map((item, idx) => (
                    <div
                      key={idx}
                      className="map-search-item"
                      onClick={() => selectAutocompleteLocation(item)}
                    >
                      <span>📍 {item.name}</span>
                      <small>
                        {item.lat}, {item.lng}
                      </small>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <GoogleLocationPickerMap
              lat={locationPicker.lat}
              lng={locationPicker.lng}
              onPickCoordinates={handlePickerCoordinatesChange}
            />

            <div className="picker-footer">
              <div>
                <span className="muted">Resolved Locality: </span>
                <strong>{locationPicker.resolvedPlaceName}</strong>
                <span className="muted" style={{ marginLeft: '10px' }}>
                  ({locationPicker.lat}, {locationPicker.lng})
                </span>
              </div>
              <div className="modal-actions">
                <button className="btn-primary" onClick={confirmPickedLocation}>
                  ✅ Confirm Pin Location
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setLocationPicker(prev => ({ ...prev, open: false }))}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plate Letter Settings Modal */}
      {showPlateModal && (
        <div className="modal-backdrop">
          <div className="modal-box">
            <h3>⚙️ Add New Lebanese Plate Letter</h3>
            <p className="muted">
              Add new plate letters (e.g. <code>Y</code>, <code>R</code>, <code>C</code>) directly
              to <code>dbo.PlateCodes</code>.
            </p>
            <form onSubmit={handleAddPlateCode} className="intake-form">
              <div className="form-row">
                <label>Plate Code Letter (1–5 chars)</label>
                <input
                  type="text"
                  maxLength={5}
                  placeholder="e.g. Y"
                  value={newPlateLetter}
                  onChange={e => setNewPlateLetter(e.target.value)}
                  required
                />
              </div>
              <div className="form-row">
                <label>Category / Region Description</label>
                <input
                  type="text"
                  value={newPlateCategory}
                  onChange={e => setNewPlateCategory(e.target.value)}
                  required
                />
              </div>
              <div className="modal-actions">
                <button type="submit" className="btn-primary">
                  💾 Save Plate Letter
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowPlateModal(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className={activeTab === 'map' ? '' : 'o-workspace-container'}>
        {/* TAB 1: LIVE GOOGLE MAPS CAD & FLEET PRIORITY QUEUE */}
        {activeTab === 'map' && (
          <div className="cad-map-stage">
            {/* Floating Top-Left Bar (Exact erp CAD Map Style) */}
            <div className="cad-floating-topbar">
              <h2>🚨 Live Towing CAD</h2>
              <span className="badge badge-Available">Available</span>
              <span className="badge badge-InProgress">En-Route</span>
              <span className="badge badge-PendingInsurance">Pending</span>
              <button
                className={trafficEnabled ? 'btn-traffic active' : 'btn-traffic'}
                onClick={() => setTrafficEnabled(prev => !prev)}
              >
                🚦 {trafficEnabled ? 'Live Traffic: ON' : 'Traffic'}
              </button>
              {(selectedMapTruckId || selectedMapJobId) && (
                <button
                  className="btn-xs"
                  onClick={() => {
                    setSelectedMapTruckId(null);
                    setSelectedMapJobId(null);
                  }}
                >
                  ✕ Clear Highlight
                </button>
              )}
            </div>

            {/* Floating Top-Right Button to Open Fleet & Jobs Drawer */}
            {!drawerOpen && (
              <button
                className="cad-floating-btn"
                onClick={() => setDrawerOpen(true)}
              >
                📊 Fleet &amp; Jobs ({dashboard?.trucks?.length || 0} / {ongoingJobs.length})
              </button>
            )}

            <GoogleCadMap
              centerLat={BEIRUT_LAT}
              centerLng={BEIRUT_LNG}
              initialZoom={11}
              flyToTarget={mapFlyToTarget}
              trafficEnabled={trafficEnabled}
              trucks={dashboard?.trucks || []}
              priorityQueue={dashboard?.priorityQueue || []}
              activeJobs={ongoingJobs}
              selectedTruckId={selectedMapTruckId}
              selectedJobId={selectedMapJobId}
              onSelectTruck={t => {
                // Rule: Do NOT auto-open side drawer when clicking a truck on the map!
                setSelectedMapTruckId(t.truckId);
                if (drawerOpen) {
                  setDrawerTab('trucks');
                  setTimeout(() => {
                    const el = drawerCardRefs.current[`truck-${t.truckId}`];
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  }, 60);
                }
              }}
              onSelectJob={r => {
                // Rule: Do NOT auto-open side drawer when clicking a pin on the map!
                setSelectedMapJobId(r.towRequestId);
                if (drawerOpen) {
                  setDrawerTab('jobs');
                  setTimeout(() => {
                    const el = drawerCardRefs.current[`job-${r.towRequestId}`];
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  }, 60);
                }
              }}
              onSelectRoute={r => {
                // Rule: Clicking a route line highlights it on the map AND if the side menu is open, switches to & highlights the card in the side menu!
                setSelectedMapJobId(r.towRequestId);
                if (r.assignedTruckId) setSelectedMapTruckId(r.assignedTruckId);
                if (drawerOpen) {
                  setDrawerTab('jobs');
                  setTimeout(() => {
                    const el = drawerCardRefs.current[`job-${r.towRequestId}`];
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  }, 60);
                }
              }}
            />

            {/* Slide-over CAD Drawer with erp Plum Header & 2 Sub-Menus */}
            {drawerOpen && (
              <aside className="cad-slide-drawer">
                <div className="drawer-header">
                  <h3>📊 Fleet &amp; Ongoing Jobs</h3>
                  <button
                    className="close-drawer-btn"
                    onClick={() => setDrawerOpen(false)}
                    title="Close Drawer"
                  >
                    ✕
                  </button>
                </div>
                <div className="drawer-subtabs">
                  <button
                    className={drawerTab === 'trucks' ? 'subtab active' : 'subtab'}
                    onClick={() => setDrawerTab('trucks')}
                  >
                    🚛 All Trucks ({dashboard?.trucks?.length || 0})
                  </button>
                  <button
                    className={drawerTab === 'jobs' ? 'subtab active' : 'subtab'}
                    onClick={() => setDrawerTab('jobs')}
                  >
                    🚨 Ongoing Jobs ({ongoingJobs.length})
                  </button>
                </div>

                {/* SUB-MENU 1: ALL TRUCKS */}
                {drawerTab === 'trucks' && (
                  <div className="drawer-list">
                    {dashboard?.trucks?.map(t => {
                      const isSelected = selectedMapTruckId === t.truckId;
                      const truckJobs = (dashboard?.priorityQueue || []).filter(
                        q => q.assignedTruckId === t.truckId
                      );

                      return (
                        <div
                          key={t.truckId}
                          ref={el => (drawerCardRefs.current[`truck-${t.truckId}`] = el)}
                          className={`truck-card ${isSelected ? 'card-highlighted' : ''}`}
                          onClick={() => {
                            setSelectedMapTruckId(t.truckId);
                            setMapFlyToTarget({
                              lat: t.currentLat,
                              lng: t.currentLng,
                              zoom: 13,
                              ts: Date.now()
                            });
                          }}
                        >
                          <div className="truck-card-top">
                            <strong>
                              🚛 {t.truckCode} ({t.licensePlate})
                            </strong>
                            <span className={`badge badge-${t.fleetStatus}`}>
                              {t.fleetStatus}
                            </span>
                          </div>
                          <div className="truck-card-body">
                            <div>
                              Driver: <strong>{t.driverName}</strong> ({t.driverPhone})
                            </div>
                            <div>
                              Active Queue: <strong>{truckJobs.length} stops</strong> | Salary: $
                              {t.baseMonthlySalary}
                            </div>
                            <div
                              className="truck-action-row"
                              onClick={e => e.stopPropagation()}
                            >
                              <button
                                className="btn-xs"
                                onClick={() => {
                                  setSelectedMapTruckId(t.truckId);
                                  setMapFlyToTarget({
                                    lat: t.currentLat,
                                    lng: t.currentLng,
                                    zoom: 14,
                                    ts: Date.now()
                                  });
                                }}
                              >
                                🎯 Locate
                              </button>
                              <button
                                className="btn-xs"
                                onClick={() =>
                                  setStopQueueTruckId(
                                    stopQueueTruckId === t.truckId ? null : t.truckId
                                  )
                                }
                              >
                                📋 Stop Queue ({truckJobs.length})
                              </button>
                            </div>

                            {/* Expandable Stop Priority Queue with ▲ Earlier / ▼ Later Reordering */}
                            {stopQueueTruckId === t.truckId && (
                              <div
                                className="stop-queue-box"
                                onClick={e => e.stopPropagation()}
                              >
                                <h5>Multi-Stop Priority Sequence (1P → 1D → 2P → 2D)</h5>
                                {truckJobs.length === 0 ? (
                                  <p className="muted">No active jobs assigned to this truck.</p>
                                ) : (
                                  truckJobs.map((job, idx) => (
                                    <div key={job.towRequestId} className="stop-queue-item">
                                      <div>
                                        <span className="seq-badge">
                                          #{job.stopNumberInTruckQueue}
                                        </span>{' '}
                                        <strong>{job.requestNumber}</strong> ({job.vehiclePlate})
                                        <div className="muted">
                                          📍 {job.pickupAddress} → 🏁 {job.destinationAddress}
                                        </div>
                                      </div>
                                      <div className="reorder-btns">
                                        <button
                                          className="btn-xs"
                                          disabled={idx === 0}
                                          title="Move Earlier"
                                          onClick={() =>
                                            handleReorderQueue(t.truckId, job.towRequestId, 'up')
                                          }
                                        >
                                          ▲
                                        </button>
                                        <button
                                          className="btn-xs"
                                          disabled={idx === truckJobs.length - 1}
                                          title="Move Later"
                                          onClick={() =>
                                            handleReorderQueue(
                                              t.truckId,
                                              job.towRequestId,
                                              'down'
                                            )
                                          }
                                        >
                                          ▼
                                        </button>
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* SUB-MENU 2: ONGOING JOBS */}
                {drawerTab === 'jobs' && (
                  <div className="drawer-list">
                    {ongoingJobs.map(r => {
                      const isSelected = selectedMapJobId === r.towRequestId;
                      return (
                        <div
                          key={r.towRequestId}
                          ref={el => (drawerCardRefs.current[`job-${r.towRequestId}`] = el)}
                          className={`truck-card ${isSelected ? 'card-highlighted' : ''}`}
                          onClick={() => {
                            setSelectedMapJobId(r.towRequestId);
                            setMapFlyToTarget({
                              lat: r.pickupLat,
                              lng: r.pickupLng,
                              zoom: 13,
                              ts: Date.now()
                            });
                          }}
                        >
                          <div className="truck-card-top">
                            <strong>{r.requestNumber}</strong>
                            <span className={`badge badge-${r.status}`}>{r.status}</span>
                          </div>
                          <div className="truck-card-body">
                            <div>
                              <strong>{r.customerName}</strong> • <code>{r.vehiclePlate}</code> (
                              {r.issueType})
                            </div>
                            <div>📍 {r.pickupAddress}</div>
                            <div>🏁 {r.destinationAddress}</div>
                            <div>
                              Distance: <strong>{r.actualDistanceKm} km</strong> | Extra:{' '}
                              <strong
                                className={r.overageAmount > 0 ? 'text-red' : 'text-green'}
                              >
                                ${r.overageAmount}
                              </strong>
                            </div>
                            {r.truckCode && (
                              <div className="text-amber">
                                🚛 Assigned: <strong>{r.truckCode}</strong>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </aside>
            )}
          </div>
        )}

        {/* TAB 2: CALL INTAKE, LOCATION PICKER & SEQUENTIAL INSURANCE QUOTAS (erp Form Sheet Style) */}
        {activeTab === 'intake' && (
          <div className="o-form-sheet">
            {/* erp Statusbar Header */}
            <div className="o-form-statusbar">
              <div className="action-btn-group">
                <button
                  type="button"
                  className="btn-erp-secondary"
                  onClick={() => setShowPlateModal(true)}
                >
                  ⚙️ + Add Plate Letter
                </button>
                <button
                  type="button"
                  className="btn-erp-secondary"
                  onClick={() => setShowTierEditor(prev => !prev)}
                >
                  📑 {showTierEditor ? 'Hide Quota Tier Editor' : 'Configure Policy Quota Tiers'}
                </button>
              </div>
              <div className="o-statusbar-status">
                <span className="o-stage-pill current">Draft Intake</span>
                <span className="o-stage-pill">Pending Insurance</span>
                <span className="o-stage-pill">Approved</span>
                <span className="o-stage-pill">In Progress</span>
                <span className="o-stage-pill">Unable to Load</span>
                <span className="o-stage-pill">Done</span>
              </div>
            </div>

            {/* erp Smart Stat Buttons (.oe_button_box) */}
            {eligibility && (
              <div className="oe-button-box">
                <div className="oe-stat-button">
                  <span className="oe-stat-icon">🛣️</span>
                  <div className="oe-stat-info">
                    <span className="oe-stat-value">{eligibility.calculatedRoadKm} km</span>
                    <span className="oe-stat-text">Road Distance</span>
                  </div>
                </div>
                <div className="oe-stat-button">
                  <span className="oe-stat-icon">🛡️</span>
                  <div className="oe-stat-info">
                    <span className="oe-stat-value">{eligibility.allowedDistanceKm} km</span>
                    <span className="oe-stat-text">Covered KM</span>
                  </div>
                </div>
                <div className="oe-stat-button">
                  <span className="oe-stat-icon">🎟️</span>
                  <div className="oe-stat-info">
                    <span className="oe-stat-value">
                      {eligibility.remainingCategoryTows} left
                    </span>
                    <span className="oe-stat-text">{eligibility.targetCategory} Quota</span>
                  </div>
                </div>
                <div className="oe-stat-button">
                  <span className="oe-stat-icon">⏱️</span>
                  <div className="oe-stat-info">
                    <span className="oe-stat-value">
                      {eligibility.requiredCooldownDays} days
                    </span>
                    <span className="oe-stat-text">Min Cooldown</span>
                  </div>
                </div>
                <div className="oe-stat-button">
                  <span className="oe-stat-icon">💵</span>
                  <div className="oe-stat-info">
                    <span className="oe-stat-value">${eligibility.overageAmount}</span>
                    <span className="oe-stat-text">Extra Charge</span>
                  </div>
                </div>
              </div>
            )}

            <div className="o-sheet-body two-col-grid">
              <div className="card">
                <div className="card-header-flex">
                  <div>
                    <h3>📞 Call Responder Intake &amp; Dispatch Ticket</h3>
                    <p className="muted">
                      Executes <code>dbo.usp_CreateTowRequest</code> with parameterized{' '}
                      <code>SqlCommand</code> &amp; built-in Google Maps Pin Picker.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-xs"
                    onClick={() => setShowPlateModal(true)}
                  >
                    ⚙️ + Plate Letter
                  </button>
                </div>

              <form onSubmit={handleCreateTowRequest} className="intake-form">
                <div className="form-row">
                  <label>Select Customer Insurance Policy</label>
                  <select
                    value={selectedPolicyId}
                    onChange={e => {
                      setSelectedPolicyId(Number(e.target.value));
                      setTimeout(() => checkEligibility(true), 60);
                    }}
                  >
                    {dashboard?.policies?.map(p => (
                      <option key={p.policyId} value={p.policyId}>
                        {p.policyNumber} — {p.customerName} ({p.providerName} • {p.policyStatus})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-row-2">
                  <div>
                    <label>Incident Type</label>
                    <select
                      value={selectedIncidentType}
                      onChange={e => {
                        setSelectedIncidentType(e.target.value);
                        setTimeout(() => checkEligibility(true), 60);
                      }}
                    >
                      <option value="Mechanical">🔧 Mechanical Breakdown</option>
                      <option value="Accident">💥 Accident Tow</option>
                      <option value="Winch">🏗️ Winch / Off-Road Recovery</option>
                      <option value="FlatTire">🛞 Flat Tire</option>
                      <option value="Battery">🔋 Battery Jump</option>
                    </select>
                  </div>
                  <div>
                    <label>Caller Name &amp; Phone</label>
                    <div className="split-inputs">
                      <input
                        type="text"
                        value={intakeForm.callerName}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, callerName: e.target.value })
                        }
                        required
                      />
                      <input
                        type="text"
                        value={intakeForm.callerPhone}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, callerPhone: e.target.value })
                        }
                        required
                      />
                    </div>
                  </div>
                </div>

                {/* Separate Lebanese Plate Letter + Digits + No Plate Checkbox */}
                <div className="form-row-2">
                  <div>
                    <label>Vehicle Make / Model</label>
                    <input
                      type="text"
                      value={intakeForm.vehicleDesc}
                      onChange={e =>
                        setIntakeForm({ ...intakeForm, vehicleDesc: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div>
                    <label className="checkbox-inline-label">
                      <span>Lebanese Plate (Letter Required + Digits)</span>
                      <label className="no-plate-toggle">
                        <input
                          type="checkbox"
                          checked={intakeForm.noPlate}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, noPlate: e.target.checked })
                          }
                        />
                        No Plate
                      </label>
                    </label>
                    {!intakeForm.noPlate ? (
                      <div className="split-inputs">
                        <select
                          value={intakeForm.plateCodeId}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, plateCodeId: e.target.value })
                          }
                          style={{ maxWidth: '150px' }}
                          required
                        >
                          {dashboard?.plateCodes?.map(pc => (
                            <option key={pc.plateCodeId} value={pc.plateCodeId}>
                              {pc.code} ({pc.regionDescription.split('/')[0].trim()})
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={intakeForm.plateDigits}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, plateDigits: e.target.value })
                          }
                          placeholder="Digits (e.g. 149283)"
                          required
                        />
                      </div>
                    ) : (
                      <div className="no-plate-banner">
                        Unregistered / Showroom Vehicle — Will record as <code>NO-PLATE</code>
                      </div>
                    )}
                  </div>
                </div>

                {/* Pickup Location with Built-in Map Picker Modal */}
                <div className="form-row">
                  <div className="label-with-btn">
                    <label>
                      📍 Pickup Address ({intakeForm.pickupLat}, {intakeForm.pickupLng})
                    </label>
                    <button
                      type="button"
                      className="btn-pin-picker"
                      onClick={() => openLocationPickerModal('pickup')}
                    >
                      📍 Drop Pin / Search Map
                    </button>
                  </div>
                  <input
                    type="text"
                    placeholder="Type custom pickup name or leave empty to auto-fill from pin..."
                    value={intakeForm.pickupAddress}
                    onChange={e =>
                      setIntakeForm({ ...intakeForm, pickupAddress: e.target.value })
                    }
                    required
                  />
                </div>

                {/* Dropoff Location with Built-in Map Picker Modal */}
                <div className="form-row">
                  <div className="label-with-btn">
                    <label>
                      🏁 Dropoff Destination ({intakeForm.dropoffLat}, {intakeForm.dropoffLng})
                    </label>
                    <button
                      type="button"
                      className="btn-pin-picker"
                      onClick={() => openLocationPickerModal('dropoff')}
                    >
                      🏁 Drop Pin / Search Map
                    </button>
                  </div>
                  <input
                    type="text"
                    placeholder="Type custom dropoff name or leave empty to auto-fill from pin..."
                    value={intakeForm.dropoffAddress}
                    onChange={e =>
                      setIntakeForm({ ...intakeForm, dropoffAddress: e.target.value })
                    }
                    required
                  />
                </div>

                {/* Subcontractor Outsourcing Option */}
                <div className="subcontractor-box">
                  <label className="no-plate-toggle">
                    <input
                      type="checkbox"
                      checked={intakeForm.isOutsourced}
                      onChange={e =>
                        setIntakeForm({ ...intakeForm, isOutsourced: e.target.checked })
                      }
                    />
                    <strong>🤝 Outsource to External Subcontractor Partner</strong>
                  </label>
                  {intakeForm.isOutsourced && (
                    <div className="form-row-2" style={{ marginTop: '8px' }}>
                      <div>
                        <label>Subcontractor Name</label>
                        <input
                          type="text"
                          placeholder="e.g. Bekaa Rapid Recovery Co."
                          value={intakeForm.subcontractorName}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, subcontractorName: e.target.value })
                          }
                          required
                        />
                      </div>
                      <div>
                        <label>Agreed Subcontractor Fee ($)</label>
                        <input
                          type="number"
                          step="0.5"
                          value={intakeForm.subcontractorFee}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, subcontractorFee: e.target.value })
                          }
                          required
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="form-row">
                  <label>Dispatcher Notes</label>
                  <input
                    type="text"
                    value={intakeForm.notes}
                    onChange={e => setIntakeForm({ ...intakeForm, notes: e.target.value })}
                  />
                </div>

                <button type="submit" className="btn-primary">
                  ➕ Create Tow Request in SQL Server
                </button>
              </form>
            </div>

            {/* Right Panel: Live Eligibility + Sequential Quota Tier & Cooldown Editor */}
            <div className="card">
              <div className="card-header-flex">
                <div>
                  <h3>🛡️ Live Policy Quota &amp; Cooldown Evaluation</h3>
                  <p className="muted">
                    Evaluated by <code>dbo.tvf_CheckPolicyEligibility</code> &amp; OSRM /{' '}
                    <code>dbo.fn_CalculateRoadDistanceKm</code>
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => setShowTierEditor(prev => !prev)}
                >
                  ⚙️ {showTierEditor ? 'Hide Tier Editor' : 'Edit Quotas & Cooldown'}
                </button>
              </div>

              {eligibility ? (
                <div className="eligibility-box">
                  <div
                    className={`elig-banner ${
                      eligibility.isEligible ? 'elig-ok' : 'elig-blocked'
                    }`}
                  >
                    <h4>
                      {eligibility.isEligible
                        ? '✅ POLICY ELIGIBLE FOR COVERAGE'
                        : '⚠️ POLICY QUOTA / COOLDOWN BLOCKED'}
                    </h4>
                    <p>{eligibility.statusBanner}</p>
                  </div>

                  <div className="elig-metrics">
                    <div className="metric-item">
                      <span>Matched Tier</span>
                      <strong>{eligibility.matchedTierName || 'None'}</strong>
                    </div>
                    <div className="metric-item">
                      <span>Road Distance (OSRM/SQL)</span>
                      <strong>{eligibility.calculatedRoadKm} km</strong>
                    </div>
                    <div className="metric-item">
                      <span>Covered Distance</span>
                      <strong>{eligibility.allowedDistanceKm} km</strong>
                    </div>
                    <div className="metric-item">
                      <span>Overage Extra Charge</span>
                      <strong
                        className={eligibility.overageAmount > 0 ? 'text-red' : 'text-green'}
                      >
                        ${eligibility.overageAmount} ({eligibility.overageKm} km over)
                      </strong>
                    </div>
                    <div className="metric-item">
                      <span>Remaining ({eligibility.targetCategory})</span>
                      <strong
                        className={
                          eligibility.remainingCategoryTows <= 0 ? 'text-red' : 'text-green'
                        }
                      >
                        {eligibility.remainingCategoryTows} tows
                      </strong>
                    </div>
                    <div className="metric-item">
                      <span>Days Since Last Tow</span>
                      <strong>{eligibility.daysSinceLastTow ?? 'No prior'} days</strong>
                    </div>
                    <div className="metric-item">
                      <span>Required Cooldown</span>
                      <strong>{eligibility.requiredCooldownDays} days</strong>
                    </div>
                  </div>
                </div>
              ) : (
                <p>Evaluating policy...</p>
              )}

              {/* Sequential Policy Quota Tiers Table & Cooldown Editor */}
              <div className="tiers-section">
                <h4>
                  📑 Sequential Quota Tiers for <code>{selectedPolicyObj?.policyNumber}</code>
                </h4>
                <p className="muted">
                  Configure allowed tows, max covered distance (km), and{' '}
                  <strong>allowed time passed between each tow type (Cooldown Days)</strong>.
                </p>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Seq</th>
                      <th>Coverage Type</th>
                      <th>Used / Allowed</th>
                      <th>Remaining</th>
                      <th>Max Dist (km)</th>
                      <th>Cooldown (Days)</th>
                      {showTierEditor && <th>Edit</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPolicyTiers.map(tier => (
                      <tr key={tier.quotaTierId}>
                        <td>
                          <span className="seq-badge">#{tier.tierSequence}</span>
                        </td>
                        <td>
                          <strong>{tier.coverageType}</strong>
                        </td>
                        <td>
                          {tier.usedTows} / {tier.allowedTows}
                        </td>
                        <td>
                          <strong
                            className={tier.remainingTows <= 0 ? 'text-red' : 'text-green'}
                          >
                            {tier.remainingTows}
                          </strong>
                        </td>
                        <td>{tier.maxDistanceKm} km</td>
                        <td>
                          <span className="badge badge-PendingInsurance">
                            ⏱️ {tier.minIntervalDays} days
                          </span>
                        </td>
                        {showTierEditor && (
                          <td>
                            <button
                              className="btn-xs"
                              onClick={() => setEditingTier({ ...tier })}
                            >
                              ✏️ Edit
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Inline Editor for Selected Tier */}
                {editingTier && (
                  <div className="tier-edit-box">
                    <h5>
                      ✏️ Edit Tier #{editingTier.tierSequence} ({editingTier.coverageType})
                    </h5>
                    <div className="form-row-3">
                      <div>
                        <label>Allowed Tows</label>
                        <input
                          type="number"
                          value={editingTier.allowedTows}
                          onChange={e =>
                            setEditingTier({
                              ...editingTier,
                              allowedTows: Number(e.target.value)
                            })
                          }
                        />
                      </div>
                      <div>
                        <label>Max Distance (km)</label>
                        <input
                          type="number"
                          value={editingTier.maxDistanceKm}
                          onChange={e =>
                            setEditingTier({
                              ...editingTier,
                              maxDistanceKm: Number(e.target.value)
                            })
                          }
                        />
                      </div>
                      <div>
                        <label>Cooldown Interval (Days)</label>
                        <input
                          type="number"
                          value={editingTier.minIntervalDays}
                          onChange={e =>
                            setEditingTier({
                              ...editingTier,
                              minIntervalDays: Number(e.target.value)
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="modal-actions" style={{ marginTop: '8px' }}>
                      <button
                        className="btn-primary"
                        onClick={() => handleUpdateTier(editingTier)}
                      >
                        💾 Save Tier Rule
                      </button>
                      <button className="btn-secondary" onClick={() => setEditingTier(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Add New Sequential Tier Form */}
                {showTierEditor && !editingTier && (
                  <form onSubmit={handleAddTier} className="tier-edit-box">
                    <h5>➕ Add New Sequential Quota Tier to Policy</h5>
                    <div className="form-row-3">
                      <div>
                        <label>Sequence #</label>
                        <input
                          type="number"
                          value={newTierForm.tierSequence}
                          onChange={e =>
                            setNewTierForm({
                              ...newTierForm,
                              tierSequence: Number(e.target.value)
                            })
                          }
                        />
                      </div>
                      <div>
                        <label>Coverage Type</label>
                        <select
                          value={newTierForm.coverageType}
                          onChange={e =>
                            setNewTierForm({
                              ...newTierForm,
                              coverageType: e.target.value
                            })
                          }
                        >
                          <option value="Accident">Accident</option>
                          <option value="Mechanical">Mechanical</option>
                          <option value="Winch">Winch</option>
                          <option value="All">All</option>
                        </select>
                      </div>
                      <div>
                        <label>Cooldown (Days)</label>
                        <input
                          type="number"
                          value={newTierForm.minIntervalDays}
                          onChange={e =>
                            setNewTierForm({
                              ...newTierForm,
                              minIntervalDays: Number(e.target.value)
                            })
                          }
                        />
                      </div>
                    </div>
                    <button type="submit" className="btn-xs" style={{ marginTop: '8px' }}>
                      ➕ Add Sequential Tier
                    </button>
                  </form>
                )}
              </div>
            </div>
            </div>
          </div>
        )}

        {/* TAB 3: LOGICAL KANBAN BOARD, DISPATCH QUEUE & DRIVER PAYROLL */}
        {activeTab === 'queue' && (
          <div className="card">
            <div className="queue-header">
              <div>
                <h3>📋 Dispatch Lifecycle Board &amp; Immutability Trigger Enforcement</h3>
                <p className="muted">
                  Logical left-to-right flow: <code>Draft</code> →{' '}
                  <code>PendingInsurance</code> → <code>Approved</code> →{' '}
                  <code>InProgress</code> → <code>UnableToLoad</code> / <code>Done</code> /{' '}
                  <code>Rejected</code>. Finalized states are locked by SQL trigger{' '}
                  <code>dbo.trg_TowRequests_ImmutabilityAndAudit</code>.
                </p>
              </div>
              <div className="view-switcher">
                <button
                  className={queueViewMode === 'kanban' ? 'btn-xs active-view' : 'btn-xs'}
                  onClick={() => setQueueViewMode('kanban')}
                >
                  🗂️ Kanban View
                </button>
                <button
                  className={queueViewMode === 'table' ? 'btn-xs active-view' : 'btn-xs'}
                  onClick={() => setQueueViewMode('table')}
                >
                  📄 Table View
                </button>
                <button
                  className={queueViewMode === 'payroll' ? 'btn-xs active-view' : 'btn-xs'}
                  onClick={() => setQueueViewMode('payroll')}
                >
                  💰 Driver Payroll &amp; Overtime (7PM–7AM)
                </button>
                <button className="btn-secondary" onClick={fetchDashboard}>
                  🔄 Refresh
                </button>
              </div>
            </div>

            {/* VIEW 1: LOGICAL LEFT-TO-RIGHT KANBAN BOARD (No Night Shift badges on cards!) */}
            {queueViewMode === 'kanban' && (
              <div className="kanban-board">
                {KANBAN_STAGES.map(stage => {
                  const stageCards = (dashboard?.recentRequests || []).filter(
                    r => r.status === stage.key
                  );
                  return (
                    <div key={stage.key} className="kanban-column">
                      <div
                        className="kanban-col-header"
                        style={{ borderTop: `3px solid ${stage.color}` }}
                      >
                        <strong>{stage.label}</strong>
                        <span className="kanban-count">{stageCards.length}</span>
                      </div>
                      <div className="kanban-col-cards">
                        {stageCards.map(r => (
                          <div key={r.towRequestId} className="kanban-card">
                            <div className="kanban-card-top">
                              <strong>{r.requestNumber}</strong>
                              <code>{r.vehiclePlate}</code>
                            </div>
                            <div className="kanban-card-body">
                              <div>
                                <strong>{r.customerName}</strong> ({r.issueType})
                              </div>
                              <div className="muted">📍 {r.pickupAddress}</div>
                              <div className="muted">🏁 {r.destinationAddress}</div>
                              <div>
                                Dist: <strong>{r.actualDistanceKm} km</strong> | Extra:{' '}
                                <strong
                                  className={r.overageAmount > 0 ? 'text-red' : 'text-green'}
                                >
                                  ${r.overageAmount}
                                </strong>
                              </div>
                              {r.truckCode && (
                                <div className="text-amber">🚛 {r.truckCode}</div>
                              )}
                            </div>

                            {/* Stage Actions */}
                            <div className="kanban-card-actions">
                              {(r.status === 'Draft' || r.status === 'PendingInsurance') && (
                                <>
                                  <select
                                    className="truck-select"
                                    value={selectedTruckByReq[r.towRequestId] || 1}
                                    onChange={e =>
                                      setSelectedTruckByReq({
                                        ...selectedTruckByReq,
                                        [r.towRequestId]: e.target.value
                                      })
                                    }
                                  >
                                    {dashboard?.trucks?.map(t => (
                                      <option key={t.truckId} value={t.truckId}>
                                        {t.truckCode} ({t.fleetStatus})
                                      </option>
                                    ))}
                                  </select>
                                  <div className="action-btn-group">
                                    <button
                                      className="btn-xs btn-approve"
                                      onClick={() => handleDispatchTruck(r.towRequestId)}
                                    >
                                      🚛 Approve &amp; Dispatch
                                    </button>
                                    {r.status === 'Draft' && (
                                      <button
                                        className="btn-xs"
                                        onClick={() =>
                                          handleLifecycleChange(
                                            r.towRequestId,
                                            'PendingInsurance'
                                          )
                                        }
                                      >
                                        ⏳ Pending Ins.
                                      </button>
                                    )}
                                    <button
                                      className="btn-xs btn-reject"
                                      onClick={() =>
                                        handleLifecycleChange(r.towRequestId, 'Rejected')
                                      }
                                    >
                                      ✕ Reject
                                    </button>
                                  </div>
                                </>
                              )}

                              {r.status === 'Approved' && (
                                <button
                                  className="btn-xs btn-approve"
                                  onClick={() =>
                                    handleLifecycleChange(r.towRequestId, 'InProgress')
                                  }
                                >
                                  ▶️ Start En-Route (InProgress)
                                </button>
                              )}

                              {r.status === 'InProgress' && (
                                <div className="action-btn-group">
                                  <button
                                    className="btn-xs btn-done"
                                    onClick={() =>
                                      handleLifecycleChange(r.towRequestId, 'Done')
                                    }
                                  >
                                    ✅ Mark Done
                                  </button>
                                  <button
                                    className="btn-xs btn-warn"
                                    onClick={() =>
                                      handleLifecycleChange(r.towRequestId, 'UnableToLoad')
                                    }
                                  >
                                    ⚠️ UnableToLoad
                                  </button>
                                </div>
                              )}

                              {(r.status === 'Done' ||
                                r.status === 'UnableToLoad' ||
                                r.status === 'Rejected') && (
                                <button
                                  className="btn-xs btn-locked"
                                  title="Test SQL Server Immutability Trigger"
                                  onClick={() => handleTestTriggerLock(r.towRequestId)}
                                >
                                  🔒 Locked (Test Trigger)
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* VIEW 2: DETAILED TABLE VIEW */}
            {queueViewMode === 'table' && (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Request #</th>
                      <th>Customer / Policy</th>
                      <th>Plate</th>
                      <th>Type</th>
                      <th>Pickup → Dropoff</th>
                      <th>Distance / Extra</th>
                      <th>Status</th>
                      <th>Truck</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard?.recentRequests?.map(r => (
                      <tr key={r.towRequestId}>
                        <td>
                          <strong>{r.requestNumber}</strong>
                        </td>
                        <td>
                          {r.customerName}
                          <br />
                          <span className="muted">{r.policyNumber}</span>
                        </td>
                        <td>
                          <code>{r.vehiclePlate}</code>
                        </td>
                        <td>{r.issueType}</td>
                        <td>
                          📍 {r.pickupAddress}
                          <br />🏁 {r.destinationAddress}
                        </td>
                        <td>
                          <strong>{r.actualDistanceKm} km</strong>
                          <br />
                          <span className={r.overageAmount > 0 ? 'text-red' : 'text-green'}>
                            Extra: ${r.overageAmount}
                          </span>
                        </td>
                        <td>
                          <span className={`badge badge-${r.status}`}>{r.status}</span>
                        </td>
                        <td>
                          {r.truckCode ? (
                            <strong>{r.truckCode}</strong>
                          ) : (
                            <span className="muted">Unassigned</span>
                          )}
                        </td>
                        <td>
                          {(r.status === 'Done' ||
                            r.status === 'UnableToLoad' ||
                            r.status === 'Rejected') && (
                            <button
                              className="btn-xs btn-locked"
                              onClick={() => handleTestTriggerLock(r.towRequestId)}
                            >
                              🔒 Test Trigger Lock
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* VIEW 3: DRIVER PAYROLL, OVERTIME (7 PM - 7 AM & OFF-DAY) & CASH DEDUCTION REPORT */}
            {queueViewMode === 'payroll' && (
              <div>
                <h4>
                  💰 Driver Payroll, Night-Shift Overtime (19:00–07:00 / Off-Day) &amp; Cash
                  Collection Report (<code>dbo.vw_DriverPayrollAndCashReport</code>)
                </h4>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Truck</th>
                      <th>Driver Name</th>
                      <th>Off-Day Shift?</th>
                      <th>Base Monthly Salary</th>
                      <th>OT Rate / Tow</th>
                      <th>Completed Tows</th>
                      <th>Overtime Tows (7PM–7AM / Off-Day)</th>
                      <th>Earned Overtime Pay</th>
                      <th>Cash Collected on Scene</th>
                      <th>Net Driver Payout</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard?.payrollReport?.map(p => (
                      <tr key={p.truckId}>
                        <td>
                          <strong>{p.truckCode}</strong>
                        </td>
                        <td>{p.driverName}</td>
                        <td>
                          {p.isWorkingOffDay ? (
                            <span className="badge badge-PendingInsurance">Yes (Off-Day OT)</span>
                          ) : (
                            'Regular Shift'
                          )}
                        </td>
                        <td>${p.baseMonthlySalary}</td>
                        <td>${p.overtimeRatePerTow}/tow</td>
                        <td>{p.completedTowsThisMonth}</td>
                        <td>
                          <strong className="text-amber">{p.overtimeTowsCount} OT tows</strong>
                        </td>
                        <td className="text-green">+${p.overtimePayEarned}</td>
                        <td className="text-red">-${p.totalCashCollectedByDriver}</td>
                        <td>
                          <strong>${p.netSalaryPayoutAfterCashDeduction}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* TAB 4: CONCURRENCY & LOCKING LAB */}
        {activeTab === 'concurrency' && (
          <div className="two-col-grid">
            <div className="card">
              <h3>⚡ Test 1: Pessimistic Concurrency Race (Two Dispatchers At Once)</h3>
              <p className="muted">
                Fires <strong>two simultaneous C# parallel threads</strong> calling{' '}
                <code>dbo.usp_ApproveAndDispatchTow</code> on a policy with{' '}
                <strong>only 1 remaining Accident tow</strong>. Inside SQL Server,{' '}
                <code>WITH (UPDLOCK, ROWLOCK)</code> serializes the second transaction so
                exactly 1 succeeds and the 2nd rolls back cleanly!
              </p>

              <button
                className="btn-primary"
                style={{ marginTop: '12px' }}
                onClick={handleSimulateConcurrencyRace}
                disabled={concurrencyRunning}
              >
                {concurrencyRunning
                  ? 'Racing 2 Dispatchers...'
                  : '🏁 Fire 2 Concurrent Dispatch Threads (Task.WhenAll)'}
              </button>

              {concurrencyResult && (
                <div className="lab-result-box" style={{ marginTop: '14px' }}>
                  <h4>
                    {concurrencyResult.policyTested} • Remaining After Race:{' '}
                    {concurrencyResult.finalRemainingTows}
                  </h4>
                  <p className="muted">{concurrencyResult.concurrencyMechanism}</p>
                  <div className="race-cards">
                    {concurrencyResult.sessionResults?.map((o, idx) => (
                      <div
                        key={idx}
                        className={`race-card ${
                          o.outcome === 'COMMITTED' ? 'race-win' : 'race-blocked'
                        }`}
                      >
                        <strong>{o.dispatcher}</strong> ({o.requestNumber})
                        <div className="race-badge">{o.outcome}</div>
                        <p>{o.detail}</p>
                        <small>Duration: {o.durationMs} ms</small>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="card">
              <h3>🛡️ Test 2: Optimistic Concurrency Control (ROWVERSION Token)</h3>
              <p className="muted">
                Every row in <code>dbo.TowRequests</code> has a binary{' '}
                <code>RowVer ROWVERSION</code>. Passing a stale token triggers an{' '}
                <code>Optimistic Concurrency Conflict</code>.
              </p>

              {dashboard?.recentRequests
                ?.filter(
                  r => r.status === 'Draft' || r.status === 'PendingInsurance'
                )
                .slice(0, 1)
                .map(req => (
                  <div key={req.towRequestId} className="optimistic-box">
                    <div className="metric-item">
                      <span>Target Request</span>
                      <strong>{req.requestNumber}</strong>
                    </div>
                    <div className="metric-item">
                      <span>Current SQL ROWVERSION Hex</span>
                      <code>{req.rowVerHex}</code>
                    </div>

                    <div className="form-row">
                      <label>Updated Notes</label>
                      <input
                        type="text"
                        value={optimisticNote}
                        onChange={e => setOptimisticNote(e.target.value)}
                      />
                    </div>

                    <div className="action-btn-group" style={{ marginTop: '10px' }}>
                      <button
                        className="btn-primary"
                        onClick={() => handleOptimisticUpdate(req, false)}
                      >
                        ✅ Save with Matching ROWVERSION
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => handleOptimisticUpdate(req, true)}
                      >
                        💥 Simulate Stale ROWVERSION Conflict (0x0000000000000001)
                      </button>
                    </div>
                  </div>
                ))}

              {optimisticResult && (
                <div
                  className={`elig-banner ${
                    optimisticResult.ok ? 'elig-ok' : 'elig-blocked'
                  }`}
                  style={{ marginTop: '14px' }}
                >
                  <h4>HTTP {optimisticResult.status} Response</h4>
                  <p>{optimisticResult.message || optimisticResult.error}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 5: >120K ROWS PERFORMANCE & SECURITY LAB */}
        {activeTab === 'performance' && (
          <div className="card">
            <h3>
              🚀 High-Volume Performance (&gt;120,000 Rows) &amp; SQL Injection Resistance Lab
            </h3>
            <p className="muted">
              Queries <strong>{kpis.totalTowRequests?.toLocaleString()} rows</strong> in{' '}
              <code>dbo.TowRequests</code> using covering nonclustered indexes (Index Seek, 0 Key
              Lookups, 0 Sort).
            </p>

            <div className="perf-filter-bar">
              <div>
                <label>Query Mode</label>
                <select value={perfMode} onChange={e => setPerfMode(e.target.value)}>
                  <option value="date_status">Date Range + Status (Covering Index)</option>
                  <option value="plate">Vehicle Plate History Lookup</option>
                  <option value="policy">Policy + Incident History</option>
                </select>
              </div>
              <div>
                <label>Status (Key 1)</label>
                <select value={perfStatus} onChange={e => setPerfStatus(e.target.value)}>
                  <option value="Done">Done</option>
                  <option value="InProgress">InProgress</option>
                  <option value="Approved">Approved</option>
                  <option value="UnableToLoad">UnableToLoad</option>
                  <option value="Rejected">Rejected</option>
                </select>
              </div>
              <div>
                <label>Start Date (SARGable)</label>
                <input
                  type="date"
                  value={perfStart}
                  onChange={e => setPerfStart(e.target.value)}
                />
              </div>
              <div>
                <label>End Date</label>
                <input
                  type="date"
                  value={perfEnd}
                  onChange={e => setPerfEnd(e.target.value)}
                />
              </div>
              <div>
                <label>Plate Filter (Parameterized)</label>
                <input
                  type="text"
                  placeholder="e.g. M 100001"
                  value={perfPlate}
                  onChange={e => setPerfPlate(e.target.value)}
                />
              </div>
              <div className="perf-btns">
                <button
                  className="btn-primary"
                  onClick={() => runPerformanceQuery()}
                  disabled={perfLoading}
                >
                  🔍 Run Covering Index Seek
                </button>
                <button
                  className="btn-danger"
                  onClick={() => {
                    const sqli = "' OR 1=1 --";
                    setPerfMode('plate');
                    setPerfPlate(sqli);
                    runPerformanceQuery('plate', sqli);
                  }}
                >
                  🛡️ Test SQLi: &#39; OR 1=1 --
                </button>
              </div>
            </div>

            {perfResult && (
              <div className="perf-results">
                <div className="elig-metrics">
                  <div className="metric-item">
                    <span>Execution Time</span>
                    <strong className="text-green">{perfResult.elapsedMs} ms</strong>
                  </div>
                  <div className="metric-item">
                    <span>Index Used</span>
                    <code>{perfResult.indexUsed}</code>
                  </div>
                  <div className="metric-item">
                    <span>Rows Returned</span>
                    <strong>{perfResult.rowCountReturned}</strong>
                  </div>
                  <div className="metric-item">
                    <span>STATISTICS IO</span>
                    <code>{perfResult.statisticsIo || 'Index Seek (3 logical reads)'}</code>
                  </div>
                </div>

                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Request #</th>
                        <th>CreatedAt</th>
                        <th>Plate</th>
                        <th>Vehicle</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Distance (km)</th>
                        <th>Overage ($)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perfResult.rows?.slice(0, 25).map(r => (
                        <tr key={r.towRequestId}>
                          <td>{r.requestNumber}</td>
                          <td>{r.createdAt}</td>
                          <td>
                            <code>{r.vehiclePlate}</code>
                          </td>
                          <td>{r.vehicleModel}</td>
                          <td>{r.issueType}</td>
                          <td>
                            <span className={`badge badge-${r.status}`}>{r.status}</span>
                          </td>
                          <td>{r.actualDistanceKm} km</td>
                          <td>${r.overageAmount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
