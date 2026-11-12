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
  { key: '× Rejected', label: '7. × Rejected (Locked)', color: '#ef4444' }
];

export default function App() {
  // Authenticated Operator Session (Backed by SQL Server dbo.SystemUsers)
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      const saved = sessionStorage.getItem('tracker_operator_session');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [loginForm, setLoginForm] = useState({
    username: 'assaad.khalife',
    password: ''
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const [activeTab, setActiveTab] = useState('map'); // 'map' | 'intake' | 'policies' | 'queue' | 'concurrency' | 'performance'
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [policyWarningModal, setPolicyWarningModal] = useState(null);
  const [incomingCallModal, setIncomingCallModal] = useState(null);

  // Call Intake & Eligibility Form State (Customer is separate 1:N parent of InsurancePolicies)
  const [selectedCustomerId, setSelectedCustomerId] = useState(1);
  const [selectedPolicyId, setSelectedPolicyId] = useState(1);
  const [selectedIncidentType, setSelectedIncidentType] = useState('Mechanical');
  const [eligibility, setEligibility] = useState(null);
  const [intakeForm, setIntakeForm] = useState({
    callerName: '',
    callerPhone: '',
    hasInsurance: true,
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
    assignedTruckId: '',
    prioritySequence: 10,
    cashCollected: 0,
    extraKmRate: 2.0,
    isNightShift: false,
    notes: ''
  });
  const [intakeNotebookTab, setIntakeNotebookTab] = useState('map'); // 'map' | 'tiers'

  // Customers & Policies Sub-Menu, Search & View Mode State
  const [custPolDropdownOpen, setCustPolDropdownOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerViewMode, setCustomerViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [policySearch, setPolicySearch] = useState('');
  const [policyViewMode, setPolicyViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [policyNotebookTab, setPolicyNotebookTab] = useState('tiers'); // 'tiers' | 'history'

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

  // Policy Quota Tier Editor & New Policy Form State
  const [editingTier, setEditingTier] = useState(null);
  const [newTierForm, setNewTierForm] = useState({
    tierSequence: 3,
    coverageType: 'All',
    allowedTows: 2,
    usedTows: 0,
    maxDistanceKm: 40,
    minIntervalDays: 7
  });
  const [showTierEditor, setShowTierEditor] = useState(true);
  const [newCustomerForm, setNewCustomerForm] = useState({
    fullName: '',
    phone: '+961-03-',
    email: ''
  });
  const [newPolicyForm, setNewPolicyForm] = useState({
    customerId: 1,
    policyNumber: `POL-2026-${Math.floor(1000 + Math.random() * 9000)}`,
    providerId: 1,
    startDate: '2026-01-01',
    expirationDate: '2027-01-01',
    defaultAllowedKm: 50,
    mechanicalAllowedTows: 3,
    mechanicalCooldownDays: 7,
    accidentAllowedTows: 1,
    accidentCooldownDays: 0
  });

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

  const handleLoginSubmit = async e => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginForm.username.trim(),
          password: loginForm.password
        })
      });
      if (!res.ok) {
        setLoginError('Invalid operator username or password. Please verify your Tracker Connect™ credentials.');
        setLoginLoading(false);
        return;
      }
      const data = await res.json();
      if (data.success && data.user) {
        sessionStorage.setItem('tracker_operator_session', JSON.stringify(data.user));
        setCurrentUser(data.user);
        showToast(
          'success',
          `Welcome back, ${data.user.fullName}`,
          `Connected to ${data.user.department} (${data.user.stationCode})`
        );
      }
    } catch (err) {
      setLoginError('Unable to reach authentication server: ' + err.message);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem('tracker_operator_session');
    setCurrentUser(null);
    setLoginForm({ username: 'assaad.khalife', password: '' });
    setLoginError('');
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
            title: 'Accident Tow Not Allowed',
            message: `The insurance policy '${policyLabel}' does not allow any accidental tows anymore! Remaining accident tows: 0. Direct customer billing is required.`,
            reason: data.statusBanner
          });
        } else if (!data.isEligible) {
          setPolicyWarningModal({
            title: 'Policy Quota / Cooldown Restriction',
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
      hasInsurance: false,
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
      assignedTruckId: '',
      prioritySequence: 10,
      cashCollected: 0,
      extraKmRate: 2.0,
      isNightShift: false,
      notes: ''
    });
    setIncomingCallModal(null);
    setActiveTab('intake');
    showToast(
      'success',
      'Incoming Call Answered',
      `Caller phone ${phoneStr} connected. Please enter the caller's details and breakdown location.`
    );
  };

  // Submit Call Intake (Supports both Save Draft and Approve & Dispatch Truck)
  const handleCreateTowRequest = async (e, autoApproveDispatch = false) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!intakeForm.noPlate && (!intakeForm.plateCodeId || !intakeForm.plateDigits.trim())) {
      showToast(
        'error',
        'Plate Letter & Digits Required',
        'Please select a Lebanese Plate Letter and enter plate digits, or check "No Plate (Unregistered)".'
      );
      return;
    }

    const policyObj = dashboard?.policies?.find(p => p.policyId === Number(selectedPolicyId));
    const chosenTruckId = intakeForm.assignedTruckId
      ? Number(intakeForm.assignedTruckId)
      : autoApproveDispatch
      ? dashboard?.trucks?.find(t => t.fleetStatus === 'Available')?.truckId || 1
      : null;

    try {
      const res = await fetch(`${API_BASE}/tow-requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: Number(selectedCustomerId) || policyObj?.customerId || 1,
          callerPhone: intakeForm.callerPhone || selectedCustomerObj?.phone || '+961-03-000000',
          plateCodeId: intakeForm.noPlate ? null : Number(intakeForm.plateCodeId),
          plateDigits: intakeForm.noPlate ? null : intakeForm.plateDigits.trim(),
          noPlate: intakeForm.noPlate,
          vehicleModel: intakeForm.vehicleDesc || 'Unspecified Vehicle',
          issueType: selectedIncidentType,
          issueNotes: intakeForm.notes,
          pickupAddress: intakeForm.pickupAddress || 'Beirut, Lebanon',
          pickupLat: Number(intakeForm.pickupLat),
          pickupLng: Number(intakeForm.pickupLng),
          destinationAddress: intakeForm.dropoffAddress || 'Destination Garage, Beirut',
          destinationLat: Number(intakeForm.dropoffLat),
          destinationLng: Number(intakeForm.dropoffLng),
          hasInsurance: intakeForm.hasInsurance !== false && Boolean(selectedPolicyId),
          policyId: intakeForm.hasInsurance !== false && selectedPolicyId ? Number(selectedPolicyId) : null,
          isOutsourced: intakeForm.isOutsourced,
          subcontractorName: intakeForm.isOutsourced ? intakeForm.subcontractorName : null,
          subcontractorFee: intakeForm.isOutsourced ? Number(intakeForm.subcontractorFee) : 0,
          assignedTruckId: chosenTruckId,
          autoApprove: Boolean(autoApproveDispatch)
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

  // Switch Selected Customer (1:N: automatically selects first policy of that customer)
  const handleSelectCustomer = custId => {
    const cid = Number(custId);
    setSelectedCustomerId(cid);
    setNewPolicyForm(prev => ({ ...prev, customerId: cid }));
    const custPolicies = (dashboard?.policies || []).filter(p => p.customerId === cid);
    if (custPolicies.length > 0) {
      setSelectedPolicyId(custPolicies[0].policyId);
      setIntakeForm(prev => ({ ...prev, hasInsurance: true }));
    } else {
      setSelectedPolicyId(0);
      setIntakeForm(prev => ({ ...prev, hasInsurance: false }));
    }
  };

  // Register Standalone Customer in dbo.Customers
  const handleCreateCustomer = async e => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCustomerForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to register customer');
      showToast('success', 'Customer Registered', data.message);
      await fetchDashboard();
      if (data.customerId) {
        setSelectedCustomerId(data.customerId);
        setNewPolicyForm(prev => ({ ...prev, customerId: data.customerId }));
        setCustomerViewMode('form');
      }
      setNewCustomerForm({ fullName: '', phone: '+961-03-', email: '' });
    } catch (err) {
      showToast('error', 'Customer Registration Failed', err.message);
    }
  };

  // Create New Insurance Policy for Selected Customer (1:N)
  const handleCreatePolicy = async e => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/policies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newPolicyForm,
          customerId: Number(newPolicyForm.customerId || selectedCustomerId),
          providerId: Number(newPolicyForm.providerId),
          defaultAllowedKm: Number(newPolicyForm.defaultAllowedKm),
          mechanicalAllowedTows: Number(newPolicyForm.mechanicalAllowedTows),
          mechanicalCooldownDays: Number(newPolicyForm.mechanicalCooldownDays),
          accidentAllowedTows: Number(newPolicyForm.accidentAllowedTows),
          accidentCooldownDays: Number(newPolicyForm.accidentCooldownDays)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create insurance policy');
      showToast('success', 'Insurance Policy Created', data.message);
      await fetchDashboard();
      if (data.customerId) {
        setSelectedCustomerId(data.customerId);
      }
      if (data.policyId) {
        setSelectedPolicyId(data.policyId);
        setPolicyViewMode('form');
      }
      setNewPolicyForm(prev => ({
        ...prev,
        policyNumber: `POL-2026-${Math.floor(1000 + Math.random() * 9000)}`
      }));
    } catch (err) {
      showToast('error', 'Policy Creation Failed', err.message);
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
          rejectionReason: newStatus === '× Rejected' ? '× Rejected by Dispatcher' : null
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
          `SQL Trigger Blocked Undo (Err ${data.sqlErrorNumber})`,
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
        <h2>Initializing Tracker Connect™ Command Center...</h2>
        <p>Connecting to National Fleet Telemetry, Insurance Partner Gateway &amp; Dispatch Database...</p>
      </div>
    );
  }

  const kpis = dashboard?.kpis || {};
  const customersList = dashboard?.customers || [];
  const selectedCustomerObj = customersList.find(c => c.customerId === Number(selectedCustomerId));
  const customerPolicies = (dashboard?.policies || []).filter(
    p => p.customerId === Number(selectedCustomerId)
  );
  const selectedPolicyObj = dashboard?.policies?.find(p => p.policyId === Number(selectedPolicyId));
  const selectedPolicyTiers = selectedPolicyObj?.tiers || [];
  const ongoingJobs = (dashboard?.recentRequests || []).filter(
    r =>
      r.status === 'Draft' ||
      r.status === 'PendingInsurance' ||
      r.status === 'Approved' ||
      r.status === 'InProgress'
  );

  // ============================================================================
  // TRACKER-INSPIRED WELCOME & OPERATOR LOGIN PORTAL (https://www.tracker.co.za/)
  // ============================================================================
  if (!currentUser) {
    const operatorProfiles = [
      {
        username: 'assaad.khalife',
        password: 'Tracker@2026',
        name: 'Assaad Khalife',
        role: 'Chief Operations & CAD Director',
        station: 'BEY-CMD-01'
      },
      {
        username: 'dispatch.beirut',
        password: 'Dispatch@2026',
        name: 'Rami Nassar',
        role: 'Senior Emergency Dispatcher',
        station: 'BEY-DSK-04'
      },
      {
        username: 'fleet.manager',
        password: 'Fleet@2026',
        name: 'Karim Haddad',
        role: 'Fleet & Recovery Supervisor',
        station: 'BEY-FLT-02'
      },
      {
        username: 'claims.underwriter',
        password: 'Claims@2026',
        name: 'Maya Khoury',
        role: 'Insurance Policy Specialist',
        station: 'BEY-INS-01'
      }
    ];

    return (
      <div className="tracker-welcome-page">
        {/* Top Emergency & Telemetry Status Ribbon */}
        <div className="tracker-top-ribbon">
          <div className="tracker-ribbon-inner">
            <div className="tracker-ribbon-left">
              <span className="tracker-pulse-dot"></span>
              <strong>24/7 NATIONAL ROADSIDE &amp; ACCIDENT COMMAND: 1544</strong>
              <span className="tracker-ribbon-sep">|</span>
              <span>Beirut • Mount Lebanon • North • Bekaa • South</span>
            </div>
            <div className="tracker-ribbon-right">
              <span>GPS Telemetry: 99.98% Online</span>
              <span>{dashboard?.trucks?.length || 12} Recovery Units Active</span>
              <span>6 Partner Insurers Linked</span>
            </div>
          </div>
        </div>

        {/* Tracker Main Public Navigation Bar */}
        <header className="tracker-public-nav">
          <div className="tracker-nav-inner">
            <div className="tracker-brand-logo">
              <div className="tracker-emblem">
                <span>T</span>
              </div>
              <div>
                <div className="tracker-brand-title">
                  TRACKER <span>CONNECT™</span>
                </div>
                <div className="tracker-brand-sub">
                  ROADSIDE ASSISTANCE, INSURANCE QUOTA &amp; FLEET CAD
                </div>
              </div>
            </div>

            <nav className="tracker-public-links">
              <a href="#solutions">For Individuals</a>
              <a href="#fleetlogic">FleetLogic™ Business</a>
              <a href="#roadside">Roadside &amp; Accident Assist</a>
              <a href="#insurers">Insurance Partners</a>
            </nav>

            <div className="tracker-nav-cta">
              <div className="tracker-hotline-pill">
                <span>Emergency Line</span>
                <strong>1544</strong>
              </div>
            </div>
          </div>
        </header>

        {/* Hero Split Section: Product Showcase + Operator Sign-In Portal */}
        <section className="tracker-hero-section">
          <div className="tracker-hero-inner">
            {/* Left Column: Tracker Brand & Product Value Proposition */}
            <div className="tracker-hero-copy">
              <div className="tracker-eyebrow-pill">
                <span>CONNECTED VEHICLE TELEMATICS &amp; 24/7 RECOVERY</span>
              </div>
              <h1>
                To care is to protect —{' '}
                <span className="tracker-accent-text">
                  every vehicle, every kilometer, every call.
                </span>
              </h1>
              <p className="tracker-hero-lead">
                Tracker Connect™ unifies 24/7 emergency roadside intake, real-time Google Maps GPS
                fleet dispatch, multi-policy insurance quota verification, and automated driver
                settlement into one mission-critical command platform.
              </p>

              {/* Live Operational Metrics Grid */}
              <div className="tracker-stats-grid">
                <div className="tracker-stat-card">
                  <div className="tracker-stat-num">
                    {(kpis.totalTowRequests || 120013).toLocaleString()}+
                  </div>
                  <div className="tracker-stat-label">National Dispatches Logged</div>
                </div>
                <div className="tracker-stat-card">
                  <div className="tracker-stat-num">&lt; 14 Min</div>
                  <div className="tracker-stat-label">Average Urban Recovery ETA</div>
                </div>
                <div className="tracker-stat-card">
                  <div className="tracker-stat-num">{kpis.availableTrucks || 8} / 12</div>
                  <div className="tracker-stat-label">Units Ready for Immediate Dispatch</div>
                </div>
                <div className="tracker-stat-card">
                  <div className="tracker-stat-num">100%</div>
                  <div className="tracker-stat-label">Real-Time Policy &amp; Cooldown Checks</div>
                </div>
              </div>

              {/* Product Pillars */}
              <div className="tracker-pillars" id="solutions">
                <div className="tracker-pillar-item">
                  <div className="tracker-pillar-icon">01</div>
                  <div>
                    <h4>24/7 Roadside &amp; Accident Assist</h4>
                    <p>
                      Instant caller CTI identification, precision GPS pin drop, OSRM road-distance
                      routing, and automated overage billing.
                    </p>
                  </div>
                </div>
                <div className="tracker-pillar-item" id="fleetlogic">
                  <div className="tracker-pillar-icon">02</div>
                  <div>
                    <h4>FleetLogic™ Live GPS CAD</h4>
                    <p>
                      Real-time recovery unit telemetry, multi-stop queue sequencing, night-shift
                      overtime tracking, and partner outsourcing.
                    </p>
                  </div>
                </div>
                <div className="tracker-pillar-item" id="insurers">
                  <div className="tracker-pillar-icon">03</div>
                  <div>
                    <h4>Multi-Policy Insurer Quota Engine</h4>
                    <p>
                      1:N customer-to-policy management across Allianz, Bankers, AXA, Medgulf,
                      Fidelity, and LIA with sequential tier &amp; cooldown enforcement.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Tracker Connect™ Command Portal Login Card */}
            <div className="tracker-login-card-wrap">
              <div className="tracker-login-card">
                <div className="tracker-login-header">
                  <div className="tracker-login-badge">
                    SHA-512 SALTED HASH • HMAC-SHA256 SESSION
                  </div>
                  <h2>Sign In to Tracker Connect™</h2>
                  <p>
                    Passwords are verified in SQL Server using per-user cryptographic salts and{' '}
                    <code>HASHBYTES(&#39;SHA2_512&#39;)</code> with zero plaintext storage.
                  </p>
                </div>

                {loginError && <div className="tracker-login-error">{loginError}</div>}

                <form onSubmit={handleLoginSubmit} className="tracker-login-form">
                  <div className="tracker-field">
                    <label>Operator Username / ID</label>
                    <input
                      type="text"
                      placeholder="e.g. assaad.khalife"
                      value={loginForm.username}
                      onChange={e => setLoginForm({ ...loginForm, username: e.target.value })}
                      required
                    />
                  </div>

                  <div className="tracker-field">
                    <div className="tracker-field-label-row">
                      <label>Password</label>
                      <button
                        type="button"
                        className="tracker-link-btn"
                        onClick={() => setShowPassword(prev => !prev)}
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Enter your portal password"
                      value={loginForm.password}
                      onChange={e => setLoginForm({ ...loginForm, password: e.target.value })}
                      required
                    />
                  </div>

                  <button type="submit" className="tracker-btn-signin" disabled={loginLoading}>
                    {loginLoading ? 'Authenticating with Command Server...' : 'Sign In to Command Portal →'}
                  </button>
                </form>

                {/* Quick Operator Role Switcher for Instant Demo / Testing */}
                <div className="tracker-quick-operators">
                  <div className="tracker-quick-title">
                    <span>Authorized Command Center Accounts (Click to Fill Credentials):</span>
                  </div>
                  <div className="tracker-operator-grid">
                    {operatorProfiles.map(op => (
                      <button
                        key={op.username}
                        type="button"
                        className={
                          loginForm.username === op.username
                            ? 'tracker-op-chip active'
                            : 'tracker-op-chip'
                        }
                        onClick={() => {
                          setLoginForm({ username: op.username, password: op.password });
                          setLoginError('');
                        }}
                      >
                        <div className="tracker-op-name">{op.name}</div>
                        <div className="tracker-op-role">{op.role}</div>
                        <div className="tracker-op-creds">
                          <code>{op.username}</code> • <span>{op.station}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Enterprise Top Navbar */}
      <header className="o-main-navbar">
        <div className="o-navbar-left">
          <div className="o-app-brand">
            <span className="tracker-mini-emblem">T</span>
            <span>TRACKER Connect™</span>
            <span className="o-app-brand-badge">FleetLogic CAD</span>
          </div>

          <nav className="o-menu-sections">
            <button
              className={activeTab === 'map' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setActiveTab('map');
              }}
            >
              Live Fleet Map
            </button>
            <button
              className={activeTab === 'queue' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setActiveTab('queue');
              }}
            >
              Dispatch Board
            </button>
            <button
              className={activeTab === 'intake' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setActiveTab('intake');
              }}
            >
              Call Desk
            </button>

            {/* Customers & Policies Dropdown with 2 Sub-Menus: 1) Customers, 2) Insurance Policies */}
            <div className="o-nav-dropdown-wrap">
              <button
                className={
                  activeTab === 'customers' || activeTab === 'policies'
                    ? 'o-nav-link active'
                    : 'o-nav-link'
                }
                onClick={() => setCustPolDropdownOpen(prev => !prev)}
              >
                Customers &amp; Policies ▾
              </button>
              {custPolDropdownOpen && (
                <div className="o-nav-dropdown-menu">
                  <button
                    type="button"
                    className={activeTab === 'customers' ? 'o-dropdown-item active' : 'o-dropdown-item'}
                    onClick={() => {
                      setActiveTab('customers');
                      setCustomerViewMode('list');
                      setCustPolDropdownOpen(false);
                    }}
                  >
                    Customers ({customersList.length})
                  </button>
                  <button
                    type="button"
                    className={activeTab === 'policies' ? 'o-dropdown-item active' : 'o-dropdown-item'}
                    onClick={() => {
                      setActiveTab('policies');
                      setPolicyViewMode('list');
                      setCustPolDropdownOpen(false);
                    }}
                  >
                    Insurance Policies ({dashboard?.policies?.length || 0})
                  </button>
                </div>
              )}
            </div>

            <button
              className={activeTab === 'concurrency' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setActiveTab('concurrency');
              }}
            >
              System Integrity
            </button>
            <button
              className={activeTab === 'performance' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setActiveTab('performance');
              }}
            >
              Dispatch Archive
            </button>
          </nav>
        </div>

        <div className="o-navbar-systray">
          <button className="btn-incoming-call" onClick={triggerIncomingCall}>
            Incoming CTI Line
          </button>
          <div className="o-systray-pill">
            <span>{currentUser.fullName}</span>
            <strong>{currentUser.stationCode}</strong>
          </div>
          <button
            type="button"
            className="btn-signout-nav"
            onClick={handleLogout}
            title="Sign out of Tracker Connect Portal"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Control Panel & Breadcrumbs */}
      {activeTab !== 'map' && (
        <div className="o-control-panel">
          <div className="o-cp-left">
            <div className="o-breadcrumb-title">
              <span>Tracker Connect™</span>
              <span className="muted">/</span>
              <span>
                {activeTab === 'intake' && 'New Call Intake & Tow Request'}
                {activeTab === 'customers' && 'Customers Directory'}
                {activeTab === 'policies' && 'Insurance Policies & Quotas'}
                {activeTab === 'queue' && 'Tow Requests Dispatch'}
                {activeTab === 'concurrency' && 'Transaction Integrity'}
                {activeTab === 'performance' && 'National Dispatch Archive'}
              </span>
            </div>

            {/* Sub-Menu Switcher & + New Action Buttons for Customers & Policies */}
            {(activeTab === 'customers' || activeTab === 'policies') && (
              <div className="action-btn-group">
                <button
                  type="button"
                  className={activeTab === 'customers' ? 'btn-erp-primary' : 'btn-erp-secondary'}
                  onClick={() => {
                    setActiveTab('customers');
                    setCustomerViewMode('list');
                  }}
                >
                  Customers
                </button>
                <button
                  type="button"
                  className={activeTab === 'policies' ? 'btn-erp-primary' : 'btn-erp-secondary'}
                  onClick={() => {
                    setActiveTab('policies');
                    setPolicyViewMode('list');
                  }}
                >
                  Insurance Policies
                </button>
                {activeTab === 'customers' && (
                  <button
                    type="button"
                    className="btn-erp-primary"
                    onClick={() => setCustomerViewMode('new')}
                  >
                    + New Customer
                  </button>
                )}
                {activeTab === 'policies' && (
                  <button
                    type="button"
                    className="btn-erp-primary"
                    onClick={() => setPolicyViewMode('new')}
                  >
                    + New Policy
                  </button>
                )}
              </div>
            )}

            {activeTab !== 'intake' && activeTab !== 'customers' && activeTab !== 'policies' && (
              <button
                className="btn-erp-primary"
                onClick={() => setActiveTab('intake')}
              >
                + New Tow Request
              </button>
            )}
          </div>

          <div className="o-cp-right">
            {activeTab === 'customers' ? (
              <input
                type="text"
                className="o-cp-search-input"
                placeholder="Search customers by name, phone, or email..."
                value={customerSearch}
                onChange={e => {
                  setCustomerSearch(e.target.value);
                  if (customerViewMode !== 'list') setCustomerViewMode('list');
                }}
              />
            ) : activeTab === 'policies' ? (
              <input
                type="text"
                className="o-cp-search-input"
                placeholder="Search policies by policy #, customer, phone, or insurer..."
                value={policySearch}
                onChange={e => {
                  setPolicySearch(e.target.value);
                  if (policyViewMode !== 'list') setPolicyViewMode('list');
                }}
              />
            ) : (
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
            )}
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
          <button onClick={() => setToast(null)}>×</button>
        </div>
      )}

      {/* Incoming Phone Call Modal (Only passes Caller Phone Number) */}
      {incomingCallModal && (
        <div className="modal-backdrop">
          <div className="modal-box incoming-call-modal">
            <div className="incoming-call-ring-badge">INCOMING EMERGENCY CALL</div>
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
                Answer Call
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
                  ? 'Pick Breakdown / Pickup Location'
                  : 'Pick Destination / Dropoff Location'}
              </h3>
              <button
                className="btn-close"
                onClick={() => setLocationPicker(prev => ({ ...prev, open: false }))}
              >
                </button>
            </div>

            {/* Floating Google Maps-style Search Bar with Autocomplete */}
            <div className="map-search-bar-wrap">
              <input
                type="text"
                className="map-search-input"
                placeholder="Search place, street, or landmark in Lebanon (e.g. Jbeil, Hamra, Jounieh)..."
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
                      <span>{item.name}</span>
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
                  Confirm Pin Location
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
            <h3>Add New Lebanese Plate Letter</h3>
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
                  Save Plate Letter
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
              <h2>Live Towing CAD</h2>
              <span className="badge badge-Available">Available</span>
              <span className="badge badge-InProgress">En-Route</span>
              <span className="badge badge-PendingInsurance">Pending</span>
              <button
                className={trafficEnabled ? 'btn-traffic active' : 'btn-traffic'}
                onClick={() => setTrafficEnabled(prev => !prev)}
              >
                {trafficEnabled ? 'Live Traffic: ON' : 'Traffic'}
              </button>
              {(selectedMapTruckId || selectedMapJobId) && (
                <button
                  className="btn-xs"
                  onClick={() => {
                    setSelectedMapTruckId(null);
                    setSelectedMapJobId(null);
                  }}
                >
                  × Clear Highlight
                </button>
              )}
            </div>

            {/* Floating Top-Right Button to Open Fleet & Jobs Drawer */}
            {!drawerOpen && (
              <button
                className="cad-floating-btn"
                onClick={() => setDrawerOpen(true)}
              >
                Fleet &amp; Jobs ({dashboard?.trucks?.length || 0} / {ongoingJobs.length})
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
                  <h3>Fleet &amp; Ongoing Jobs</h3>
                  <button
                    className="close-drawer-btn"
                    onClick={() => setDrawerOpen(false)}
                    title="Close Drawer"
                  >
                    </button>
                </div>
                <div className="drawer-subtabs">
                  <button
                    className={drawerTab === 'trucks' ? 'subtab active' : 'subtab'}
                    onClick={() => setDrawerTab('trucks')}
                  >
                    All Trucks ({dashboard?.trucks?.length || 0})
                  </button>
                  <button
                    className={drawerTab === 'jobs' ? 'subtab active' : 'subtab'}
                    onClick={() => setDrawerTab('jobs')}
                  >
                    Ongoing Jobs ({ongoingJobs.length})
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
                              {t.truckCode} ({t.licensePlate})
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
                                Locate
                              </button>
                              <button
                                className="btn-xs"
                                onClick={() =>
                                  setStopQueueTruckId(
                                    stopQueueTruckId === t.truckId ? null : t.truckId
                                  )
                                }
                              >
                                Stop Queue ({truckJobs.length})
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
                                          {job.pickupAddress} → {job.destinationAddress}
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
                            <div>{r.pickupAddress}</div>
                            <div>{r.destinationAddress}</div>
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
                                Assigned: <strong>{r.truckCode}</strong>
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

        {/* ==========================================================================
            TAB 2: CALL DESK & TOW REQUEST FORM SHEET (Exact Replica of Form View)
           ========================================================================== */}
        {activeTab === 'intake' && (
          <div className="o-form-sheet">
            {/* Form Header Bar: Action Buttons on Left, Statusbar on Right */}
            <div className="o-form-statusbar">
              <div className="action-btn-group">
                <button
                  type="button"
                  className="btn-erp-primary"
                  onClick={e => handleCreateTowRequest(e, true)}
                >
                  Approve &amp; Dispatch Truck
                </button>
                <button
                  type="button"
                  className="btn-erp-secondary"
                  onClick={e => handleCreateTowRequest(e, false)}
                >
                  Save Draft Ticket
                </button>
                <button
                  type="button"
                  className="btn-erp-secondary"
                  onClick={e => handleCreateTowRequest(e, false)}
                >
                  Put in Pending Insurance
                </button>
                <button
                  type="button"
                  className="btn-erp-secondary"
                  onClick={() => setShowPlateModal(true)}
                >
                  + Plate Letter
                </button>
              </div>
              <div className="o-statusbar-status">
                <span className="o-stage-pill current">Draft Request</span>
                <span className="o-stage-pill">Pending Insurance</span>
                <span className="o-stage-pill">Approved &amp; Dispatched</span>
                <span className="o-stage-pill">Towing in Progress</span>
                <span className="o-stage-pill">Completed &amp; Billed</span>
              </div>
            </div>

            {/* Form Sheet Body */}
            <form onSubmit={e => handleCreateTowRequest(e, false)} className="erp-sheet-pad">
              {/* Top Alert Banner: Policy Status */}
              <div
                className={
                  !intakeForm.hasInsurance
                    ? 'erp-alert-banner alert-neutral'
                    : eligibility?.isEligible
                    ? 'erp-alert-banner alert-ok'
                    : 'erp-alert-banner alert-warn'
                }
              >
                <strong>Policy Status: </strong>
                <span>
                  {!intakeForm.hasInsurance
                    ? 'Direct Customer Billing (Not Covered by Insurance)'
                    : eligibility?.statusBanner || 'Evaluating policy quota and cooldown rules...'}
                </span>
              </div>

              {/* Document Title (oe_title) */}
              <div className="erp-oe-title">
                <span className="erp-oe-label">Tow Request #</span>
                <h1>New</h1>
              </div>

              {/* GROUP ROW 1: Customer & Telephony Intake | Vehicle & Breakdown Issue */}
              <div className="erp-group-grid">
                <div className="erp-group-col">
                  <div className="erp-group-header">CUSTOMER &amp; TELEPHONY INTAKE</div>

                  <div className="erp-field-row">
                    <label>Customer / Caller</label>
                    <div className="erp-field-val">
                      <div className="split-inputs">
                        <select
                          value={selectedCustomerId}
                          onChange={e => {
                            const cid = Number(e.target.value);
                            handleSelectCustomer(cid);
                            const cust = customersList.find(c => c.customerId === cid);
                            if (cust) {
                              setIntakeForm(prev => ({
                                ...prev,
                                callerName: cust.fullName,
                                callerPhone: prev.callerPhone || cust.phone
                              }));
                            }
                            setTimeout(() => checkEligibility(true), 60);
                          }}
                        >
                          {customersList.map(c => (
                            <option key={c.customerId} value={c.customerId}>
                              {c.fullName} ({c.phone})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn-xs"
                          title="Manage or Add Customer"
                          onClick={() => {
                            setActiveTab('customers');
                            setCustomerViewMode('new');
                          }}
                        >
                          + New
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Phone Number</label>
                    <div className="erp-field-val">
                      <input
                        type="text"
                        placeholder="Captured Caller Phone Number"
                        value={intakeForm.callerPhone}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, callerPhone: e.target.value })
                        }
                        required
                      />
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Covered by Insurance</label>
                    <div className="erp-field-val">
                      <label className="erp-toggle-switch">
                        <input
                          type="checkbox"
                          checked={intakeForm.hasInsurance}
                          onChange={e => {
                            const checked = e.target.checked;
                            setIntakeForm({ ...intakeForm, hasInsurance: checked });
                            if (checked && customerPolicies.length > 0) {
                              setSelectedPolicyId(customerPolicies[0].policyId);
                              setTimeout(() => checkEligibility(true), 60);
                            }
                          }}
                        />
                        <span>{intakeForm.hasInsurance ? 'Yes — Active Coverage' : 'No — Cash Call'}</span>
                      </label>
                    </div>
                  </div>

                  {intakeForm.hasInsurance && (
                    <>
                      <div className="erp-field-row">
                        <label>Insurance Policy</label>
                        <div className="erp-field-val">
                          <select
                            value={selectedPolicyId}
                            onChange={e => {
                              const pid = Number(e.target.value);
                              setSelectedPolicyId(pid);
                              setTimeout(() => checkEligibility(true), 60);
                            }}
                          >
                            {customerPolicies.length === 0 ? (
                              <option value={0}>No Policies Linked to Selected Customer</option>
                            ) : (
                              customerPolicies.map(p => (
                                <option key={p.policyId} value={p.policyId}>
                                  {p.policyNumber} ({p.providerName} • {p.policyStatus})
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Applied Policy Quota Tier</label>
                        <div className="erp-field-val">
                          <input
                            type="text"
                            readOnly
                            className="erp-readonly-input"
                            value={
                              eligibility?.matchedTierName
                                ? `${eligibility.matchedTierName} (${eligibility.remainingCategoryTows} remaining • Max ${eligibility.allowedDistanceKm} KM)`
                                : 'No Matching Tier Available'
                            }
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Insurance Provider</label>
                        <div className="erp-field-val">
                          <span className="erp-readonly-text">
                            {selectedPolicyObj?.providerName || '—'}
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="erp-group-col">
                  <div className="erp-group-header">VEHICLE &amp; BREAKDOWN ISSUE</div>

                  <div className="erp-field-row">
                    <label>License Plate</label>
                    <div className="erp-field-val">
                      <div className="erp-plate-flex">
                        {!intakeForm.noPlate && (
                          <>
                            <select
                              value={intakeForm.plateCodeId}
                              onChange={e =>
                                setIntakeForm({ ...intakeForm, plateCodeId: e.target.value })
                              }
                              style={{ width: '130px', flexShrink: 0 }}
                              required={!intakeForm.noPlate}
                            >
                              {dashboard?.plateCodes?.map(pc => (
                                <option key={pc.plateCodeId} value={pc.plateCodeId}>
                                  {pc.code} ({pc.regionDescription.split('/')[0].trim()})
                                </option>
                              ))}
                            </select>
                            <input
                              type="text"
                              placeholder="e.g. 452100"
                              value={intakeForm.plateDigits}
                              onChange={e =>
                                setIntakeForm({ ...intakeForm, plateDigits: e.target.value })
                              }
                              required={!intakeForm.noPlate}
                            />
                          </>
                        )}
                        <label className="erp-toggle-switch" style={{ whiteSpace: 'nowrap' }}>
                          <input
                            type="checkbox"
                            checked={intakeForm.noPlate}
                            onChange={e =>
                              setIntakeForm({ ...intakeForm, noPlate: e.target.checked })
                            }
                          />
                          <span>No Plate</span>
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Combined Plate</label>
                    <div className="erp-field-val">
                      <strong className="erp-combined-plate">
                        {intakeForm.noPlate
                          ? 'NO-PLATE'
                          : `${
                              dashboard?.plateCodes?.find(
                                pc => pc.plateCodeId === Number(intakeForm.plateCodeId)
                              )?.code || 'M'
                            } ${intakeForm.plateDigits || '—'}`}
                      </strong>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Car Make / Model</label>
                    <div className="erp-field-val">
                      <input
                        type="text"
                        placeholder="e.g. BMW 520i / Toyota Camry"
                        value={intakeForm.vehicleDesc}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, vehicleDesc: e.target.value })
                        }
                        required
                      />
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Breakdown Issue</label>
                    <div className="erp-field-val">
                      <select
                        value={selectedIncidentType}
                        onChange={e => {
                          setSelectedIncidentType(e.target.value);
                          setTimeout(() => checkEligibility(true), 60);
                        }}
                      >
                        <option value="Mechanical">Mechanical Breakdown</option>
                        <option value="Accident">Accident Tow</option>
                        <option value="Battery">Dead Battery</option>
                        <option value="FlatTire">Flat Tire</option>
                        <option value="Winch">Ditch / Winch Extraction</option>
                      </select>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Problem Notes</label>
                    <div className="erp-field-val">
                      <input
                        type="text"
                        placeholder="Details of the breakdown..."
                        value={intakeForm.notes}
                        onChange={e => setIntakeForm({ ...intakeForm, notes: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* GROUP ROW 2: Pickup & Destination Coordinates */}
              <div className="erp-group-grid">
                <div className="erp-group-col">
                  <div className="erp-group-header">PICKUP BREAKDOWN LOCATION</div>

                  <div className="erp-field-row">
                    <label>Pickup Breakdown Location</label>
                    <div className="erp-field-val">
                      <div className="split-inputs">
                        <input
                          type="text"
                          placeholder="Breakdown Location (Where the car is)"
                          value={intakeForm.pickupAddress}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, pickupAddress: e.target.value })
                          }
                          required
                        />
                        <button
                          type="button"
                          className="btn-pin-picker"
                          onClick={() => openLocationPickerModal('pickup')}
                        >
                          Drop Pin / Search
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Pickup Latitude</label>
                    <div className="erp-field-val">
                      <input
                        type="number"
                        step="0.0001"
                        value={intakeForm.pickupLat}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, pickupLat: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Pickup Longitude</label>
                    <div className="erp-field-val">
                      <input
                        type="number"
                        step="0.0001"
                        value={intakeForm.pickupLng}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, pickupLng: e.target.value })
                        }
                      />
                    </div>
                  </div>
                </div>

                <div className="erp-group-col">
                  <div className="erp-group-header">DESTINATION / DROPOFF</div>

                  <div className="erp-field-row">
                    <label>Destination / Dropoff</label>
                    <div className="erp-field-val">
                      <div className="split-inputs">
                        <input
                          type="text"
                          placeholder="Dropoff Location (Garage / Home)"
                          value={intakeForm.dropoffAddress}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, dropoffAddress: e.target.value })
                          }
                          required
                        />
                        <button
                          type="button"
                          className="btn-pin-picker"
                          onClick={() => openLocationPickerModal('dropoff')}
                        >
                          Drop Pin / Search
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Dropoff Latitude</label>
                    <div className="erp-field-val">
                      <input
                        type="number"
                        step="0.0001"
                        value={intakeForm.dropoffLat}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, dropoffLat: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Dropoff Longitude</label>
                    <div className="erp-field-val">
                      <input
                        type="number"
                        step="0.0001"
                        value={intakeForm.dropoffLng}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, dropoffLng: e.target.value })
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* GROUP ROW 3: Distance & Overage Billing Calculation */}
              <div className="erp-group-grid">
                <div className="erp-group-col">
                  <div className="erp-group-header">DISTANCE &amp; OVERAGE BILLING CALCULATION</div>

                  <div className="erp-field-row">
                    <label>Actual Trip Distance (KM)</label>
                    <div className="erp-field-val">
                      <strong>{eligibility?.calculatedRoadKm ?? 0} KM</strong>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Allowed Policy Distance (KM)</label>
                    <div className="erp-field-val">
                      <span>
                        {intakeForm.hasInsurance ? `${eligibility?.allowedDistanceKm ?? 0} KM` : '0 KM'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="erp-group-col">
                  <div className="erp-group-header">OVERAGE &amp; EXCESS FEE</div>

                  <div className="erp-field-row">
                    <label>Excess KM to Bill</label>
                    <div className="erp-field-val">
                      <span>{eligibility?.overageKm ?? 0} KM</span>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Excess Rate ($/KM)</label>
                    <div className="erp-field-val">
                      <span>$2.00 / KM</span>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Total Excess Amount to Bill ($)</label>
                    <div className="erp-field-val">
                      <strong
                        className={
                          (eligibility?.overageAmount || 0) > 0 ? 'text-red' : 'text-green'
                        }
                        style={{ fontSize: '15px' }}
                      >
                        ${eligibility?.overageAmount ?? 0}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>

              {/* GROUP ROW 4: Dispatching & Resources | On-Scene Cash & Overtime Tracking */}
              <div className="erp-group-grid">
                <div className="erp-group-col">
                  <div className="erp-group-header">DISPATCHING &amp; RESOURCES</div>

                  <div className="erp-field-row">
                    <label>Outsource to Subcontractor</label>
                    <div className="erp-field-val">
                      <label className="erp-toggle-switch">
                        <input
                          type="checkbox"
                          checked={intakeForm.isOutsourced}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, isOutsourced: e.target.checked })
                          }
                        />
                        <span>
                          {intakeForm.isOutsourced
                            ? 'External Subcontractor Partner'
                            : 'Internal Fleet Tow Truck'}
                        </span>
                      </label>
                    </div>
                  </div>

                  {!intakeForm.isOutsourced ? (
                    <>
                      <div className="erp-field-row">
                        <label>Assigned Tow Truck</label>
                        <div className="erp-field-val">
                          <select
                            value={intakeForm.assignedTruckId}
                            onChange={e =>
                              setIntakeForm({ ...intakeForm, assignedTruckId: e.target.value })
                            }
                          >
                            <option value="">Choose internal tow truck...</option>
                            {dashboard?.trucks?.map(t => (
                              <option key={t.truckId} value={t.truckId}>
                                {t.truckCode} — {t.licensePlate} ({t.fleetStatus})
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Priority Stop Order</label>
                        <div className="erp-field-val">
                          <input
                            type="number"
                            value={intakeForm.prioritySequence}
                            onChange={e =>
                              setIntakeForm({
                                ...intakeForm,
                                prioritySequence: Number(e.target.value)
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Assigned Driver</label>
                        <div className="erp-field-val">
                          <span className="erp-readonly-text">
                            {dashboard?.trucks?.find(
                              t => t.truckId === Number(intakeForm.assignedTruckId)
                            )?.driverName || 'Auto-assigned on dispatch'}
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="erp-field-row">
                        <label>Subcontractor Partner</label>
                        <div className="erp-field-val">
                          <input
                            type="text"
                            placeholder="Choose external partner..."
                            value={intakeForm.subcontractorName}
                            onChange={e =>
                              setIntakeForm({
                                ...intakeForm,
                                subcontractorName: e.target.value
                              })
                            }
                            required={intakeForm.isOutsourced}
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Agreed Subcontractor Fee ($)</label>
                        <div className="erp-field-val">
                          <input
                            type="number"
                            step="0.5"
                            value={intakeForm.subcontractorFee}
                            onChange={e =>
                              setIntakeForm({
                                ...intakeForm,
                                subcontractorFee: e.target.value
                              })
                            }
                            required={intakeForm.isOutsourced}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="erp-group-col">
                  <div className="erp-group-header">ON-SCENE CASH &amp; OVERTIME TRACKING</div>

                  <div className="erp-field-row">
                    <label>Cash Collected by Driver ($)</label>
                    <div className="erp-field-val">
                      <input
                        type="number"
                        step="0.5"
                        value={intakeForm.cashCollected}
                        onChange={e =>
                          setIntakeForm({ ...intakeForm, cashCollected: e.target.value })
                        }
                      />
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Night Shift Tow (19:00 - 07:00)</label>
                    <div className="erp-field-val">
                      <label className="erp-toggle-switch">
                        <input
                          type="checkbox"
                          checked={intakeForm.isNightShift}
                          onChange={e =>
                            setIntakeForm({ ...intakeForm, isNightShift: e.target.checked })
                          }
                        />
                        <span>Night / Off-Day Overtime Applicable</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              {/* BOTTOM NOTEBOOK (<notebook>) */}
              <div className="erp-notebook">
                <div className="erp-notebook-tabs">
                  <button
                    type="button"
                    className={
                      intakeNotebookTab === 'map' ? 'erp-nb-tab active' : 'erp-nb-tab'
                    }
                    onClick={() => setIntakeNotebookTab('map')}
                  >
                    Built-in Live Incident &amp; Fleet Map
                  </button>
                  <button
                    type="button"
                    className={
                      intakeNotebookTab === 'tiers' ? 'erp-nb-tab active' : 'erp-nb-tab'
                    }
                    onClick={() => setIntakeNotebookTab('tiers')}
                  >
                    Policy Quota Tiers ({selectedPolicyObj?.policyNumber || 'None'})
                  </button>
                </div>

                <div className="erp-notebook-page">
                  {intakeNotebookTab === 'map' ? (
                    <div style={{ height: '340px', position: 'relative', borderRadius: '6px', overflow: 'hidden' }}>
                      <GoogleCadMap
                        centerLat={Number(intakeForm.pickupLat) || BEIRUT_LAT}
                        centerLng={Number(intakeForm.pickupLng) || BEIRUT_LNG}
                        initialZoom={12}
                        trafficEnabled={trafficEnabled}
                        trucks={dashboard?.trucks || []}
                        priorityQueue={dashboard?.priorityQueue || []}
                        activeJobs={[
                          {
                            towRequestId: 999999,
                            requestNumber: 'NEW-CALL',
                            customerName:
                              selectedCustomerObj?.fullName || intakeForm.callerName || 'Caller',
                            vehiclePlate: intakeForm.noPlate
                              ? 'NO-PLATE'
                              : intakeForm.plateDigits || 'NEW',
                            vehicleModel: intakeForm.vehicleDesc || 'Vehicle',
                            issueType: selectedIncidentType,
                            pickupAddress: intakeForm.pickupAddress || 'Pickup Pin',
                            pickupLat: Number(intakeForm.pickupLat) || BEIRUT_LAT,
                            pickupLng: Number(intakeForm.pickupLng) || BEIRUT_LNG,
                            destinationAddress: intakeForm.dropoffAddress || 'Destination Pin',
                            destinationLat: Number(intakeForm.dropoffLat) || 33.894,
                            destinationLng: Number(intakeForm.dropoffLng) || 35.552,
                            actualDistanceKm: eligibility?.calculatedRoadKm || 0,
                            allowedDistanceKm: eligibility?.allowedDistanceKm || 0,
                            overageKm: eligibility?.overageKm || 0,
                            overageAmount: eligibility?.overageAmount || 0,
                            status: 'Draft'
                          }
                        ]}
                      />
                    </div>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Seq</th>
                          <th>Coverage Type</th>
                          <th>Used / Allowed</th>
                          <th>Remaining</th>
                          <th>Max Dist (KM)</th>
                          <th>Min Days Between Tows</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedPolicyTiers.map(tier => (
                          <tr key={tier.quotaTierId}>
                            <td>#{tier.tierSequence}</td>
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
                            <td>{tier.maxDistanceKm} KM</td>
                            <td>{tier.minIntervalDays} days</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </form>
          </div>
        )}

        {/* ==========================================================================
            SUB-SECTION 1: CUSTOMERS DIRECTORY (Search List, Customer Sheet, + New)
           ========================================================================== */}
        {activeTab === 'customers' && (
          <div className="o-form-sheet">
            {customerViewMode === 'list' && (
              <div className="erp-sheet-pad">
                <div className="card-header-flex" style={{ marginBottom: '12px' }}>
                  <div>
                    <h3>Customers Directory</h3>
                    <p className="muted">
                      Click any customer to inspect their contact record and all linked insurance
                      policies (1:N), or click <strong>+ New Customer</strong> to register a new
                      customer.
                    </p>
                  </div>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Customer Full Name</th>
                      <th>Phone Number</th>
                      <th>Email Address</th>
                      <th>Linked Insurance Policies</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customersList
                      .filter(c => {
                        const q = customerSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          c.fullName.toLowerCase().includes(q) ||
                          c.phone.toLowerCase().includes(q) ||
                          (c.email || '').toLowerCase().includes(q)
                        );
                      })
                      .map(c => (
                        <tr
                          key={c.customerId}
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            handleSelectCustomer(c.customerId);
                            setCustomerViewMode('form');
                          }}
                        >
                          <td>#{c.customerId}</td>
                          <td>
                            <strong>{c.fullName}</strong>
                          </td>
                          <td>{c.phone}</td>
                          <td>{c.email || '—'}</td>
                          <td>
                            <span className="badge badge-Approved">
                              {c.policyCount} {c.policyCount === 1 ? 'Policy' : 'Policies'}
                            </span>
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            <div className="action-btn-group">
                              <button
                                type="button"
                                className="btn-xs"
                                onClick={() => {
                                  handleSelectCustomer(c.customerId);
                                  setCustomerViewMode('form');
                                }}
                              >
                                View Customer
                              </button>
                              <button
                                type="button"
                                className="btn-xs"
                                onClick={() => {
                                  handleSelectCustomer(c.customerId);
                                  setNewPolicyForm(prev => ({
                                    ...prev,
                                    customerId: c.customerId
                                  }));
                                  setActiveTab('policies');
                                  setPolicyViewMode('new');
                                }}
                              >
                                + Add Policy
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {customerViewMode === 'form' && selectedCustomerObj && (
              <>
                <div className="o-form-statusbar">
                  <div className="action-btn-group">
                    <button
                      type="button"
                      className="btn-erp-secondary"
                      onClick={() => setCustomerViewMode('list')}
                    >
                      ← Back to Customers List
                    </button>
                    <button
                      type="button"
                      className="btn-erp-primary"
                      onClick={() => {
                        setNewPolicyForm(prev => ({
                          ...prev,
                          customerId: selectedCustomerObj.customerId
                        }));
                        setActiveTab('policies');
                        setPolicyViewMode('new');
                      }}
                    >
                      + Attach New Policy to {selectedCustomerObj.fullName}
                    </button>
                  </div>
                  <div className="o-statusbar-status">
                    <span className="o-stage-pill current">Active Customer</span>
                  </div>
                </div>

                <div className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">Customer Record #{selectedCustomerObj.customerId}</span>
                    <h1>{selectedCustomerObj.fullName}</h1>
                  </div>

                  <div className="erp-group-grid">
                    <div className="erp-group-col">
                      <div className="erp-group-header">CONTACT INFORMATION</div>
                      <div className="erp-field-row">
                        <label>Full Name</label>
                        <div className="erp-field-val">
                          <strong>{selectedCustomerObj.fullName}</strong>
                        </div>
                      </div>
                      <div className="erp-field-row">
                        <label>Phone Number</label>
                        <div className="erp-field-val">
                          <span>{selectedCustomerObj.phone}</span>
                        </div>
                      </div>
                      <div className="erp-field-row">
                        <label>Email Address</label>
                        <div className="erp-field-val">
                          <span>{selectedCustomerObj.email || '—'}</span>
                        </div>
                      </div>
                    </div>

                    <div className="erp-group-col">
                      <div className="erp-group-header">INSURANCE PORTFOLIO SUMMARY</div>
                      <div className="erp-field-row">
                        <label>Active Policies Count</label>
                        <div className="erp-field-val">
                          <strong>{customerPolicies.length} Policies on File</strong>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="erp-notebook">
                    <div className="erp-notebook-tabs">
                      <button type="button" className="erp-nb-tab active">
                        Customer&apos;s Insurance Policies ({customerPolicies.length})
                      </button>
                    </div>
                    <div className="erp-notebook-page">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Policy Number</th>
                            <th>Insurance Provider</th>
                            <th>Start Date</th>
                            <th>Expiration Date</th>
                            <th>Covered Distance (KM)</th>
                            <th>Status</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {customerPolicies.map(p => (
                            <tr key={p.policyId}>
                              <td>
                                <strong>{p.policyNumber}</strong>
                              </td>
                              <td>{p.providerName}</td>
                              <td>{p.startDate}</td>
                              <td>{p.expirationDate}</td>
                              <td>{p.defaultAllowedKm} KM</td>
                              <td>
                                <span className="badge badge-Done">{p.policyStatus}</span>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="btn-xs"
                                  onClick={() => {
                                    setSelectedPolicyId(p.policyId);
                                    setActiveTab('policies');
                                    setPolicyViewMode('form');
                                  }}
                                >
                                  Open Policy &amp; Quotas
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </>
            )}

            {customerViewMode === 'new' && (
              <>
                <div className="o-form-statusbar">
                  <div className="action-btn-group">
                    <button
                      type="button"
                      className="btn-erp-secondary"
                      onClick={() => setCustomerViewMode('list')}
                    >
                      ← Discard / Back to List
                    </button>
                  </div>
                  <div className="o-statusbar-status">
                    <span className="o-stage-pill current">New Customer Registration</span>
                  </div>
                </div>

                <form onSubmit={handleCreateCustomer} className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">New Customer Record</span>
                    <h1>{newCustomerForm.fullName || 'New Customer'}</h1>
                  </div>

                  <div className="erp-group-grid">
                    <div className="erp-group-col">
                      <div className="erp-group-header">CUSTOMER DETAILS</div>
                      <div className="erp-field-row">
                        <label>Full Name</label>
                        <div className="erp-field-val">
                          <input
                            type="text"
                            placeholder="e.g. Rami Kanaan"
                            value={newCustomerForm.fullName}
                            onChange={e =>
                              setNewCustomerForm({
                                ...newCustomerForm,
                                fullName: e.target.value
                              })
                            }
                            required
                          />
                        </div>
                      </div>
                      <div className="erp-field-row">
                        <label>Phone Number</label>
                        <div className="erp-field-val">
                          <input
                            type="text"
                            placeholder="+961-03-889900"
                            value={newCustomerForm.phone}
                            onChange={e =>
                              setNewCustomerForm({
                                ...newCustomerForm,
                                phone: e.target.value
                              })
                            }
                            required
                          />
                        </div>
                      </div>
                      <div className="erp-field-row">
                        <label>Email Address</label>
                        <div className="erp-field-val">
                          <input
                            type="email"
                            placeholder="customer@domain.com"
                            value={newCustomerForm.email}
                            onChange={e =>
                              setNewCustomerForm({
                                ...newCustomerForm,
                                email: e.target.value
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <button type="submit" className="btn-erp-primary">
                    Save Customer Record
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {/* ==========================================================================
            SUB-SECTION 2: INSURANCE POLICIES & QUOTAS (List, Policy Form Sheet, + New)
           ========================================================================== */}
        {activeTab === 'policies' && (
          <div className="o-form-sheet">
            {/* VIEW 1: SEARCHABLE POLICIES LIST VIEW */}
            {policyViewMode === 'list' && (
              <div className="erp-sheet-pad">
                <div className="card-header-flex" style={{ marginBottom: '12px' }}>
                  <div>
                    <h3>Insurance Policies &amp; Quotas</h3>
                    <p className="muted">
                      Click any policy row to open its full Coverage &amp; Sequential Quota Tiers
                      Form Sheet, or click <strong>+ New Policy</strong> to issue a new policy.
                    </p>
                  </div>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Policy Number</th>
                      <th>Customer</th>
                      <th>Insurance Provider</th>
                      <th>Expiration Date</th>
                      <th>Covered Distance</th>
                      <th>Mechanical Tows (Left / Allowed)</th>
                      <th>Accident Tows (Left / Allowed)</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.policies || [])
                      .filter(p => {
                        const q = policySearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          p.policyNumber.toLowerCase().includes(q) ||
                          p.customerName.toLowerCase().includes(q) ||
                          (p.customerPhone || '').toLowerCase().includes(q) ||
                          p.providerName.toLowerCase().includes(q)
                        );
                      })
                      .map(p => {
                        const tiers = p.tiers || [];
                        const mechTiers = tiers.filter(
                          t => t.coverageType === 'Mechanical' || t.coverageType === 'All'
                        );
                        const accTiers = tiers.filter(
                          t => t.coverageType === 'Accident' || t.coverageType === 'All'
                        );
                        const allowMech = mechTiers.reduce((s, t) => s + t.allowedTows, 0);
                        const leftMech = mechTiers.reduce((s, t) => s + t.remainingTows, 0);
                        const allowAcc = accTiers.reduce((s, t) => s + t.allowedTows, 0);
                        const leftAcc = accTiers.reduce((s, t) => s + t.remainingTows, 0);

                        return (
                          <tr
                            key={p.policyId}
                            style={{ cursor: 'pointer' }}
                            onClick={() => {
                              setSelectedCustomerId(p.customerId);
                              setSelectedPolicyId(p.policyId);
                              setPolicyViewMode('form');
                            }}
                          >
                            <td>
                              <strong>{p.policyNumber}</strong>
                            </td>
                            <td>
                              {p.customerName} <span className="muted">({p.customerPhone})</span>
                            </td>
                            <td>{p.providerName}</td>
                            <td>{p.expirationDate}</td>
                            <td>{p.defaultAllowedKm} KM</td>
                            <td>
                              <strong className={leftMech <= 0 ? 'text-red' : 'text-green'}>
                                {leftMech}
                              </strong>{' '}
                              / {allowMech}
                            </td>
                            <td>
                              <strong className={leftAcc <= 0 ? 'text-red' : 'text-green'}>
                                {leftAcc}
                              </strong>{' '}
                              / {allowAcc}
                            </td>
                            <td>
                              <span
                                className={`badge ${
                                  p.policyStatus === 'Active' ? 'badge-Done' : 'badge-Rejected'
                                }`}
                              >
                                {p.policyStatus}
                              </span>
                            </td>
                            <td onClick={e => e.stopPropagation()}>
                              <button
                                type="button"
                                className="btn-xs"
                                onClick={() => {
                                  setSelectedCustomerId(p.customerId);
                                  setSelectedPolicyId(p.policyId);
                                  setPolicyViewMode('form');
                                }}
                              >
                                Open Policy Sheet
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}

            {/* VIEW 2: INSURANCE POLICY FORM SHEET (Exact Replica of view_tow_insurance_policy_form) */}
            {policyViewMode === 'form' && selectedPolicyObj && (
              <>
                <div className="o-form-statusbar">
                  <div className="action-btn-group">
                    <button
                      type="button"
                      className="btn-erp-secondary"
                      onClick={() => setPolicyViewMode('list')}
                    >
                      ← Back to Policies List
                    </button>
                    <button
                      type="button"
                      className="btn-erp-primary"
                      onClick={() => setPolicyViewMode('new')}
                    >
                      + New Policy
                    </button>
                  </div>
                  <div className="o-statusbar-status">
                    <span
                      className={
                        selectedPolicyObj.policyStatus === 'Active'
                          ? 'o-stage-pill current'
                          : 'o-stage-pill'
                      }
                    >
                      Active
                    </span>
                    <span className="o-stage-pill">Quota Exceeded</span>
                    <span
                      className={
                        selectedPolicyObj.policyStatus === 'Expired'
                          ? 'o-stage-pill current'
                          : 'o-stage-pill'
                      }
                    >
                      Expired
                    </span>
                  </div>
                </div>

                <div className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">Policy Number</span>
                    <h1>{selectedPolicyObj.policyNumber}</h1>
                  </div>

                  {(() => {
                    const tiers = selectedPolicyTiers;
                    const totalAllowed = tiers.reduce((s, t) => s + t.allowedTows, 0);
                    const totalUsed = tiers.reduce((s, t) => s + t.usedTows, 0);
                    const totalRemaining = tiers.reduce((s, t) => s + t.remainingTows, 0);

                    const mechTiers = tiers.filter(
                      t => t.coverageType === 'Mechanical' || t.coverageType === 'All'
                    );
                    const accTiers = tiers.filter(
                      t => t.coverageType === 'Accident' || t.coverageType === 'All'
                    );

                    const allowMech = mechTiers.reduce((s, t) => s + t.allowedTows, 0);
                    const usedMech = mechTiers.reduce((s, t) => s + t.usedTows, 0);
                    const leftMech = mechTiers.reduce((s, t) => s + t.remainingTows, 0);

                    const allowAcc = accTiers.reduce((s, t) => s + t.allowedTows, 0);
                    const usedAcc = accTiers.reduce((s, t) => s + t.usedTows, 0);
                    const leftAcc = accTiers.reduce((s, t) => s + t.remainingTows, 0);

                    return (
                      <>
                        {/* GROUP 1: Coverage Details | Total Quotas Summary */}
                        <div className="erp-group-grid">
                          <div className="erp-group-col">
                            <div className="erp-group-header">COVERAGE DETAILS</div>
                            <div className="erp-field-row">
                              <label>Customer</label>
                              <div className="erp-field-val">
                                <strong>{selectedPolicyObj.customerName}</strong> (
                                {selectedPolicyObj.customerPhone})
                              </div>
                            </div>
                            <div className="erp-field-row">
                              <label>Insurance Provider</label>
                              <div className="erp-field-val">
                                <span>{selectedPolicyObj.providerName}</span>
                              </div>
                            </div>
                            <div className="erp-field-row">
                              <label>Start Date</label>
                              <div className="erp-field-val">
                                <span>{selectedPolicyObj.startDate}</span>
                              </div>
                            </div>
                            <div className="erp-field-row">
                              <label>Expiration Date</label>
                              <div className="erp-field-val">
                                <span>{selectedPolicyObj.expirationDate}</span>
                              </div>
                            </div>
                            <div className="erp-field-row">
                              <label>Covered Distance (KM/Tow)</label>
                              <div className="erp-field-val">
                                <strong>{selectedPolicyObj.defaultAllowedKm} KM</strong>
                              </div>
                            </div>
                            <div className="erp-field-row">
                              <label>Default Min Days Between Tows</label>
                              <div className="erp-field-val">
                                <span>{selectedPolicyObj.defaultMinIntervalDays} days</span>
                              </div>
                            </div>
                          </div>

                          <div className="erp-group-col">
                            <div className="erp-group-header">TOTAL QUOTAS SUMMARY</div>
                            <div className="erp-field-row">
                              <label>Total Allowed Tows</label>
                              <div className="erp-field-val">
                                <strong>{totalAllowed}</strong>
                              </div>
                            </div>
                            <div className="erp-field-row">
                              <label>Total Used Tows</label>
                              <div className="erp-field-val">
                                <span>{totalUsed}</span>
                              </div>
                            </div>
                            <div className="erp-field-row">
                              <label>Total Remaining Tows</label>
                              <div className="erp-field-val">
                                <strong style={{ fontSize: '16px', color: 'var(--erp-brand)' }}>
                                  {totalRemaining}
                                </strong>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* GROUP 2: Tow Breakdown Quotas (Separate Allowances) */}
                        <div className="erp-group-grid">
                          <div className="erp-group-col">
                            <div className="erp-group-header">MECHANICAL BREAKDOWNS</div>
                            <div className="erp-field-row">
                              <label>Allowed Mechanical Tows</label>
                              <div className="erp-field-val">{allowMech}</div>
                            </div>
                            <div className="erp-field-row">
                              <label>Used Mechanical Tows</label>
                              <div className="erp-field-val">{usedMech}</div>
                            </div>
                            <div className="erp-field-row">
                              <label>Remaining Mechanical Tows</label>
                              <div className="erp-field-val">
                                <strong className={leftMech > 0 ? 'text-green' : 'text-red'}>
                                  {leftMech}
                                </strong>
                              </div>
                            </div>
                          </div>

                          <div className="erp-group-col">
                            <div className="erp-group-header">ACCIDENT TOWS</div>
                            <div className="erp-field-row">
                              <label>Allowed Accident Tows</label>
                              <div className="erp-field-val">{allowAcc}</div>
                            </div>
                            <div className="erp-field-row">
                              <label>Used Accident Tows</label>
                              <div className="erp-field-val">{usedAcc}</div>
                            </div>
                            <div className="erp-field-row">
                              <label>Remaining Accident Tows</label>
                              <div className="erp-field-val">
                                <strong className={leftAcc > 0 ? 'text-green' : 'text-red'}>
                                  {leftAcc}
                                </strong>
                              </div>
                            </div>
                          </div>
                        </div>
                      </>
                    );
                  })()}

                  {/* BOTTOM NOTEBOOK (<notebook>) */}
                  <div className="erp-notebook">
                    <div className="erp-notebook-tabs">
                      <button
                        type="button"
                        className={
                          policyNotebookTab === 'tiers' ? 'erp-nb-tab active' : 'erp-nb-tab'
                        }
                        onClick={() => setPolicyNotebookTab('tiers')}
                      >
                        Coverage Quota Tiers (Sequential Priority)
                      </button>
                      <button
                        type="button"
                        className={
                          policyNotebookTab === 'history' ? 'erp-nb-tab active' : 'erp-nb-tab'
                        }
                        onClick={() => setPolicyNotebookTab('history')}
                      >
                        Tow History Under This Policy
                      </button>
                    </div>

                    <div className="erp-notebook-page">
                      {policyNotebookTab === 'tiers' ? (
                        <>
                          <p className="muted" style={{ marginBottom: '10px' }}>
                            Quotas are consumed strictly in priority sequence order (e.g. 1st:
                            Mechanical Tows up to 50 KM, then 2nd: Mechanical Tows up to 100 KM).
                          </p>
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Sequence</th>
                                <th>Tier Description</th>
                                <th>Issue Type</th>
                                <th>Allowed Tows</th>
                                <th>Max Distance (KM)</th>
                                <th>Min Days Between Tows</th>
                                <th>Used Tows</th>
                                <th>Remaining Tows</th>
                                <th>Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedPolicyTiers.map(tier => (
                                <tr key={tier.quotaTierId}>
                                  <td>#{tier.tierSequence}</td>
                                  <td>
                                    Tier #{tier.tierSequence} — {tier.coverageType} (
                                    {tier.maxDistanceKm} KM)
                                  </td>
                                  <td>
                                    <strong>{tier.coverageType}</strong>
                                  </td>
                                  <td>{tier.allowedTows}</td>
                                  <td>{tier.maxDistanceKm} KM</td>
                                  <td>{tier.minIntervalDays} days</td>
                                  <td>{tier.usedTows}</td>
                                  <td>
                                    <span
                                      className={`badge ${
                                        tier.remainingTows > 0 ? 'badge-Done' : 'badge-Rejected'
                                      }`}
                                    >
                                      {tier.remainingTows}
                                    </span>
                                  </td>
                                  <td>
                                    <button
                                      type="button"
                                      className="btn-xs"
                                      onClick={() => setEditingTier({ ...tier })}
                                    >
                                      Edit
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>

                          {editingTier && (
                            <div className="tier-edit-box">
                              <h5>
                                Edit Tier #{editingTier.tierSequence} ({editingTier.coverageType})
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
                                  <label>Max Distance (KM)</label>
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
                                  <label>Min Days Between Tows (Cooldown)</label>
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
                                  type="button"
                                  className="btn-primary"
                                  onClick={() => handleUpdateTier(editingTier)}
                                >
                                  Save Tier Rule
                                </button>
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  onClick={() => setEditingTier(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}

                          {!editingTier && (
                            <form onSubmit={handleAddTier} className="tier-edit-box">
                              <h5>+ Add a Line (New Sequential Quota Tier)</h5>
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
                                  <label>Issue Type</label>
                                  <select
                                    value={newTierForm.coverageType}
                                    onChange={e =>
                                      setNewTierForm({
                                        ...newTierForm,
                                        coverageType: e.target.value
                                      })
                                    }
                                  >
                                    <option value="Mechanical">Mechanical</option>
                                    <option value="Accident">Accident</option>
                                    <option value="Winch">Winch</option>
                                    <option value="All">All</option>
                                  </select>
                                </div>
                                <div>
                                  <label>Min Days Between Tows</label>
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
                                + Add Sequential Tier
                              </button>
                            </form>
                          )}
                        </>
                      ) : (
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Request #</th>
                              <th>Call Time</th>
                              <th>Vehicle Plate</th>
                              <th>Breakdown Issue</th>
                              <th>Actual Distance (KM)</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(dashboard?.recentRequests || [])
                              .filter(r => r.policyId === selectedPolicyObj.policyId)
                              .map(r => (
                                <tr key={r.towRequestId}>
                                  <td>
                                    <strong>{r.requestNumber}</strong>
                                  </td>
                                  <td>{r.createdAt}</td>
                                  <td>
                                    <code>{r.vehiclePlate}</code>
                                  </td>
                                  <td>{r.issueType}</td>
                                  <td>{r.actualDistanceKm} KM</td>
                                  <td>
                                    <span className={`badge badge-${r.status}`}>{r.status}</span>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* VIEW 3: + NEW POLICY FORM SHEET */}
            {policyViewMode === 'new' && (
              <>
                <div className="o-form-statusbar">
                  <div className="action-btn-group">
                    <button
                      type="button"
                      className="btn-erp-secondary"
                      onClick={() => setPolicyViewMode('list')}
                    >
                      ← Discard / Back to Policies List
                    </button>
                  </div>
                  <div className="o-statusbar-status">
                    <span className="o-stage-pill current">New Policy Draft</span>
                    <span className="o-stage-pill">Active</span>
                  </div>
                </div>

                <form onSubmit={handleCreatePolicy} className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">Policy Number</span>
                    <h1>{newPolicyForm.policyNumber}</h1>
                  </div>

                  <div className="erp-group-grid">
                    <div className="erp-group-col">
                      <div className="erp-group-header">COVERAGE DETAILS</div>
                      <div className="erp-field-row">
                        <label>Customer</label>
                        <div className="erp-field-val">
                          <select
                            value={newPolicyForm.customerId || selectedCustomerId}
                            onChange={e => {
                              const cid = Number(e.target.value);
                              setNewPolicyForm({ ...newPolicyForm, customerId: cid });
                              handleSelectCustomer(cid);
                            }}
                          >
                            {customersList.map(c => (
                              <option key={c.customerId} value={c.customerId}>
                                {c.fullName} ({c.phone}) — {c.policyCount} Policies
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Insurance Provider</label>
                        <div className="erp-field-val">
                          <select
                            value={newPolicyForm.providerId}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                providerId: Number(e.target.value)
                              })
                            }
                          >
                            <option value={1}>Allianz SNA Lebanon (ALLIANZ-LB)</option>
                            <option value={2}>Bankers Assurance SAL (BANKERS-LB)</option>
                            <option value={3}>AXA Middle East SAL (AXA-ME)</option>
                            <option value={4}>Medgulf Insurance SAL (MEDGULF-LB)</option>
                            <option value={5}>Fidelity Insurance Group (FIDELITY-LB)</option>
                            <option value={6}>LIA Assurex SAL (LIA-LB)</option>
                          </select>
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Policy Number</label>
                        <div className="erp-field-val">
                          <input
                            type="text"
                            value={newPolicyForm.policyNumber}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                policyNumber: e.target.value
                              })
                            }
                            required
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Start Date</label>
                        <div className="erp-field-val">
                          <input
                            type="date"
                            value={newPolicyForm.startDate}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                startDate: e.target.value
                              })
                            }
                            required
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Expiration Date</label>
                        <div className="erp-field-val">
                          <input
                            type="date"
                            value={newPolicyForm.expirationDate}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                expirationDate: e.target.value
                              })
                            }
                            required
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Covered Distance (KM/Tow)</label>
                        <div className="erp-field-val">
                          <input
                            type="number"
                            value={newPolicyForm.defaultAllowedKm}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                defaultAllowedKm: Number(e.target.value)
                              })
                            }
                            required
                          />
                        </div>
                      </div>
                    </div>

                    <div className="erp-group-col">
                      <div className="erp-group-header">INITIAL TOW BREAKDOWN QUOTAS</div>

                      <div className="erp-field-row">
                        <label>Allowed Mechanical Tows</label>
                        <div className="erp-field-val">
                          <input
                            type="number"
                            value={newPolicyForm.mechanicalAllowedTows}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                mechanicalAllowedTows: Number(e.target.value)
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Mechanical Cooldown (Days)</label>
                        <div className="erp-field-val">
                          <input
                            type="number"
                            value={newPolicyForm.mechanicalCooldownDays}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                mechanicalCooldownDays: Number(e.target.value)
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Allowed Accident Tows</label>
                        <div className="erp-field-val">
                          <input
                            type="number"
                            value={newPolicyForm.accidentAllowedTows}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                accidentAllowedTows: Number(e.target.value)
                              })
                            }
                          />
                        </div>
                      </div>

                      <div className="erp-field-row">
                        <label>Accident Cooldown (Days)</label>
                        <div className="erp-field-val">
                          <input
                            type="number"
                            value={newPolicyForm.accidentCooldownDays}
                            onChange={e =>
                              setNewPolicyForm({
                                ...newPolicyForm,
                                accidentCooldownDays: Number(e.target.value)
                              })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <button type="submit" className="btn-erp-primary">
                    Save &amp; Activate Insurance Policy
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {/* TAB 3: LOGICAL KANBAN BOARD, DISPATCH QUEUE & DRIVER PAYROLL */}
        {activeTab === 'queue' && (
          <div className="card">
            <div className="queue-header">
              <div>
                <h3>Dispatch Lifecycle Board &amp; Immutability Trigger Enforcement</h3>
                <p className="muted">
                  Logical left-to-right flow: <code>Draft</code> →{' '}
                  <code>PendingInsurance</code> → <code>Approved</code> →{' '}
                  <code>InProgress</code> → <code>UnableToLoad</code> / <code>Done</code> /{' '}
                  <code>× Rejected</code>. Finalized states are locked by SQL trigger{' '}
                  <code>dbo.trg_TowRequests_ImmutabilityAndAudit</code>.
                </p>
              </div>
              <div className="view-switcher">
                <button
                  className={queueViewMode === 'kanban' ? 'btn-xs active-view' : 'btn-xs'}
                  onClick={() => setQueueViewMode('kanban')}
                >
                  Kanban View
                </button>
                <button
                  className={queueViewMode === 'table' ? 'btn-xs active-view' : 'btn-xs'}
                  onClick={() => setQueueViewMode('table')}
                >
                  Table View
                </button>
                <button
                  className={queueViewMode === 'payroll' ? 'btn-xs active-view' : 'btn-xs'}
                  onClick={() => setQueueViewMode('payroll')}
                >
                  Driver Payroll &amp; Overtime (7PM–7AM)
                </button>
                <button className="btn-secondary" onClick={fetchDashboard}>
                  Refresh
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
                              <div className="muted">{r.pickupAddress}</div>
                              <div className="muted">{r.destinationAddress}</div>
                              <div>
                                Dist: <strong>{r.actualDistanceKm} km</strong> | Extra:{' '}
                                <strong
                                  className={r.overageAmount > 0 ? 'text-red' : 'text-green'}
                                >
                                  ${r.overageAmount}
                                </strong>
                              </div>
                              {r.truckCode && (
                                <div className="text-amber">{r.truckCode}</div>
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
                                      Approve &amp; Dispatch
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
                                        Pending Ins.
                                      </button>
                                    )}
                                    <button
                                      className="btn-xs btn-reject"
                                      onClick={() =>
                                        handleLifecycleChange(r.towRequestId, '× Rejected')
                                      }
                                    >
                                      × Reject
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
                                  ▶Start En-Route (InProgress)
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
                                    Mark Done
                                  </button>
                                  <button
                                    className="btn-xs btn-warn"
                                    onClick={() =>
                                      handleLifecycleChange(r.towRequestId, 'UnableToLoad')
                                    }
                                  >
                                    UnableToLoad
                                  </button>
                                </div>
                              )}

                              {(r.status === 'Done' ||
                                r.status === 'UnableToLoad' ||
                                r.status === '× Rejected') && (
                                <button
                                  className="btn-xs btn-locked"
                                  title="Test SQL Server Immutability Trigger"
                                  onClick={() => handleTestTriggerLock(r.towRequestId)}
                                >
                                  Locked (Test Trigger)
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
                          {r.pickupAddress}
                          <br />{r.destinationAddress}
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
                            r.status === '× Rejected') && (
                            <button
                              className="btn-xs btn-locked"
                              onClick={() => handleTestTriggerLock(r.towRequestId)}
                            >
                              Test Trigger Lock
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
                  Driver Payroll, Night-Shift Overtime (19:00–07:00 / Off-Day) &amp; Cash
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

        {/* TAB 4: TRANSACTION INTEGRITY & MULTI-OPERATOR PROTECTION */}
        {activeTab === 'concurrency' && (
          <div className="two-col-grid">
            <div className="card">
              <h3>Multi-Operator Dispatch Serialization (Pessimistic Quota Lock)</h3>
              <p className="muted">
                Protects customer policy quotas when two dispatchers assign the final remaining tow
                simultaneously. SQL Server <code>WITH (UPDLOCK, ROWLOCK)</code> inside{' '}
                <code>dbo.usp_ApproveAndDispatchTow</code> serializes concurrent approvals so
                quotas can never be over-allocated.
              </p>

              <button
                className="btn-primary"
                style={{ marginTop: '12px' }}
                onClick={handleSimulateConcurrencyRace}
                disabled={concurrencyRunning}
              >
                {concurrencyRunning
                  ? 'Verifying Concurrent Dispatch Locks...'
                  : 'Verify Multi-Operator Quota Protection (2 Simultaneous Approvals)'}
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
              <h3>Optimistic Ticket Version Control (ROWVERSION Token)</h3>
              <p className="muted">
                Every dispatch record in <code>dbo.TowRequests</code> carries a hardware-incremented{' '}
                <code>RowVer ROWVERSION</code> token to prevent a dispatcher from overwriting a
                colleague&apos;s changes with stale form data.
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
                        Save with Matching ROWVERSION
                      </button>
                      <button
                        className="btn-danger"
                        onClick={() => handleOptimisticUpdate(req, true)}
                      >
                        Simulate Stale ROWVERSION Conflict (0x0000000000000001)
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

        {/* TAB 5: NATIONAL DISPATCH ARCHIVE & SECURITY AUDIT */}
        {activeTab === 'performance' && (
          <div className="card">
            <h3>
              National Dispatch Archive ({kpis.totalTowRequests?.toLocaleString()} Records) &amp;
              Security Diagnostics
            </h3>
            <p className="muted">
              Instantaneous search across{' '}
              <strong>{kpis.totalTowRequests?.toLocaleString()} historical roadside dispatches</strong>{' '}
              in <code>dbo.TowRequests</code> powered by covering nonclustered indexes and
              100% parameterized ADO.NET queries.
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
                  <option value="× Rejected">× Rejected</option>
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
                  Run Covering Index Seek
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
                  Test SQLi: &#39; OR 1=1 --
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
