import React, { useState, useEffect, useRef } from 'react';
import { GoogleCadMap, GoogleLocationPickerMap } from './GoogleMapEngine';

const API_BASE = '/api';

// Default center: Beirut, Lebanon
const BEIRUT_LAT = 33.8938;
const BEIRUT_LNG = 35.5018;

const KANBAN_STAGES = [
  { key: 'Draft', label: 'Draft', color: '#64748b' },
  { key: 'PendingInsurance', label: 'Pending Insurance', color: '#f59e0b' },
  { key: 'Approved', label: 'Approved', color: '#3b82f6' },
  { key: 'InProgress', label: 'In Progress', color: '#8b5cf6' },
  { key: 'UnableToLoad', label: 'Unable to Load', color: '#f97316' },
  { key: 'Done', label: 'Completed', color: '#10b981' },
  { key: 'Rejected', label: 'Rejected', color: '#ef4444' }
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
    username: '',
    password: ''
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showStationSwitcher, setShowStationSwitcher] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');

  const apiFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (currentUser?.sessionToken) {
      headers.set('Authorization', `Bearer ${currentUser.sessionToken}`);
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 && currentUser) {
      sessionStorage.removeItem('tracker_operator_session');
      setCurrentUser(null);
    }
    return res;
  };

  const [activeTab, setActiveTab] = useState('map'); // 'map' | 'intake' | 'policies' | 'queue' | 'concurrency' | 'performance'
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [policyWarningModal, setPolicyWarningModal] = useState(null);
  const [incomingCallModal, setIncomingCallModal] = useState(null);

  // Call Intake & Eligibility Form State (Customer is separate 1:N parent of InsurancePolicies & Vehicles)
  const [selectedCustomerId, setSelectedCustomerId] = useState(1);
  const [selectedPolicyId, setSelectedPolicyId] = useState(1);
  const [selectedVehicleId, setSelectedVehicleId] = useState('');
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
    verifiedRoadDistanceKm: '',
    isOutsourced: false,
    subcontractorId: 1,
    subcontractorFee: 65.0,
    assignedTruckId: '',
    prioritySequence: 10,
    cashCollected: 0,
    extraKmRate: 2.5,
    isNightShift: false,
    notes: ''
  });
  const [intakeNotebookTab, setIntakeNotebookTab] = useState('map'); // 'map' | 'tiers'

  // Customers, Policies, Billing & Configuration Dropdowns & Normalized Master-Detail State
  const [custPolDropdownOpen, setCustPolDropdownOpen] = useState(false);
  const [opsBillingDropdownOpen, setOpsBillingDropdownOpen] = useState(false);
  const [configDropdownOpen, setConfigDropdownOpen] = useState(false);
  const [configSearch, setConfigSearch] = useState('');

  const [customerSearch, setCustomerSearch] = useState('');
  const [customerViewMode, setCustomerViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [customerNotebookTab, setCustomerNotebookTab] = useState('policies'); // 'policies' | 'vehicles' | 'tows'
  const [editingCustomerForm, setEditingCustomerForm] = useState(null);

  const [policySearch, setPolicySearch] = useState('');
  const [policyViewMode, setPolicyViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [policyNotebookTab, setPolicyNotebookTab] = useState('tiers'); // 'tiers' | 'history'

  // Configuration -> Tow Trucks Master-Detail State
  const [truckViewMode, setTruckViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [selectedTruckForm, setSelectedTruckForm] = useState(null);
  const [truckNotebookTab, setTruckNotebookTab] = useState('assignments'); // 'assignments' | 'tows'
  const [newTruckForm, setNewTruckForm] = useState({
    truckCode: 'TRK-BEY-09',
    licensePlate: 'P 509100',
    truckModel: 'Isuzu NPR75 Flatbed Winch',
    maxPayloadKg: 5500,
    currentLat: BEIRUT_LAT,
    currentLng: BEIRUT_LNG,
    fleetStatus: 'Available'
  });

  // Configuration -> Drivers Master-Detail State
  const [driverViewMode, setDriverViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [editingDriver, setEditingDriver] = useState(null);
  const [driverNotebookTab, setDriverNotebookTab] = useState('assignments'); // 'assignments' | 'tows' | 'payroll'
  const [newDriverForm, setNewDriverForm] = useState({
    employeeCode: 'DRV-111',
    fullName: '',
    phone: '+961-70-',
    licenseNumber: 'LB-COM-2026-',
    baseMonthlySalary: 900.0,
    overtimeRatePerTow: 16.0,
    isWorkingOffDay: false,
    driverStatus: 'Active'
  });
  const [assignDriverForm, setAssignDriverForm] = useState({
    driverId: 9,
    truckId: 3,
    assignmentNotes: 'Shift rotation via normalized DriverTruckAssignments'
  });

  // Billing & Tariffs Master-Detail State
  const [tariffViewMode, setTariffViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [selectedTariffId, setSelectedTariffId] = useState(null);
  const [newTariffForm, setNewTariffForm] = useState({
    tariffCode: 'TRF-2026-Q4',
    tariffName: '2026 Q4 Updated Mechanical Tariff',
    serviceCategory: 'Mechanical',
    baseFee: 40.0,
    pricePerKm: 2.75,
    nightSurcharge: 18.0,
    effectiveFrom: '2026-11-16'
  });

  const [invoiceViewMode, setInvoiceViewMode] = useState('list'); // 'list' | 'form'
  const [selectedInvoiceId, setSelectedInvoiceId] = useState(null);
  const [billingSearch, setBillingSearch] = useState('');
  const [paymentModalInvoice, setPaymentModalInvoice] = useState(null);
  const [paymentForm, setPaymentForm] = useState({
    payerType: 'InsuranceProvider',
    amountPaid: 25.0,
    paymentMethod: 'BankTransfer',
    referenceNumber: 'PAY-2026-PARTIAL',
    collectedByDriverId: '',
    notes: 'Partial obligation settlement'
  });

  // Dispatch Queue Detail Sheet State
  const [selectedTowRequestId, setSelectedTowRequestId] = useState(null);
  const [towDetailNotebookTab, setTowDetailNotebookTab] = useState('invoice'); // 'invoice' | 'audits'

  // Configuration -> User Groups (Owns Permissions) & Users (Assigned to GroupId) Master-Detail State
  const [userGroups, setUserGroups] = useState([]);
  const [groupViewMode, setGroupViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [editingGroup, setEditingGroup] = useState(null);
  const [newGroupForm, setNewGroupForm] = useState({
    groupCode: 'SHIFT_SUPERVISOR',
    groupName: 'Night Shift Supervisors',
    description: 'Supervises overnight CAD dispatch, fleet availability, and emergency escalations.',
    canDispatch: true,
    canManageFleet: true,
    canManagePolicies: true,
    canManageBilling: false,
    canManageUsers: false
  });

  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [userViewMode, setUserViewMode] = useState('list'); // 'list' | 'form' | 'new'
  const [editingUser, setEditingUser] = useState(null);
  const [userNotebookTab, setUserNotebookTab] = useState('tows'); // 'tows' | 'payments' | 'audits'
  const [newUserForm, setNewUserForm] = useState({
    username: '',
    password: '',
    fullName: '',
    roleTitle: 'Emergency Roadside Dispatcher',
    department: '24/7 Roadside Desk',
    stationCode: 'BEY-DSK-08',
    groupId: 2,
    isActive: true
  });

  // Side Tab & Inline Record Chatter State
  const CHANGE_LOG_SECTIONS = {
    users: 'Users',
    groups: 'User Groups',
    trucks: 'Tow Trucks',
    drivers: 'Drivers',
    customers: 'Customers',
    policies: 'Policies & Quotas',
    tariffs: 'Tariffs',
    billing: 'Invoices & Payments',
    queue: 'Dispatch Queue',
    performance: 'Dispatch Archive',
    concurrency: 'Concurrency'
  };
  const [changeLogOpen, setChangeLogOpen] = useState(false);
  const [changeLogFilter, setChangeLogFilter] = useState('');
  const [changeLogs, setChangeLogs] = useState([]);
  const [changeLogLoading, setChangeLogLoading] = useState(false);

  // Full 120k+ Tow Request Detail & Inline Record Odoo Logs State
  const [archiveViewMode, setArchiveViewMode] = useState('list'); // 'list' | 'detail'
  const [towDetailData, setTowDetailData] = useState(null); // { tow, payments, logs }
  const [towDetailLoading, setTowDetailLoading] = useState(false);
  const [recordInlineLogs, setRecordInlineLogs] = useState([]);
  const [recordInlineLogsLoading, setRecordInlineLogsLoading] = useState(false);

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

  useEffect(() => {
    const closeTopDialog = event => {
      if (event.key !== 'Escape') return;
      if (showPlateModal) setShowPlateModal(false);
      else if (locationPicker.open) setLocationPicker(prev => ({ ...prev, open: false }));
      else if (policyWarningModal) setPolicyWarningModal(null);
      else if (incomingCallModal) setIncomingCallModal(null);
    };
    document.addEventListener('keydown', closeTopDialog);
    return () => document.removeEventListener('keydown', closeTopDialog);
  }, [showPlateModal, locationPicker.open, policyWarningModal, incomingCallModal]);

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
    setLoginForm({ username: '', password: '' });
    setLoginError('');
  };

  const fetchDashboard = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/dashboard`);
      if (!res.ok) {
        if (res.status === 401) {
          sessionStorage.removeItem('tracker_operator_session');
          setCurrentUser(null);
          throw new Error('Your operator session expired. Please sign in again.');
        }
        throw new Error(`Dashboard request failed (${res.status})`);
      }
      const data = await res.json();
      setDashboard(data);
    } catch (err) {
      showToast('error', 'Backend Connection Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (currentUser?.sessionToken) {
      setLoading(true);
      fetchDashboard();
    } else {
      setLoading(false);
    }
  }, [currentUser?.sessionToken]);

  // Check Policy Eligibility + Active Tariff & Road-Distance Provenance
  const checkEligibility = async (showPopupOnViolation = false) => {
    if (!currentUser?.sessionToken) return;
    const effectivePid = intakeForm.hasInsurance && selectedPolicyId ? Number(selectedPolicyId) : 0;
    const verifiedParam =
      intakeForm.verifiedRoadDistanceKm && Number(intakeForm.verifiedRoadDistanceKm) > 0
        ? `&verifiedKm=${encodeURIComponent(intakeForm.verifiedRoadDistanceKm)}`
        : '';
    try {
      const url = `${API_BASE}/policies/${effectivePid}/check-eligibility?issueType=${encodeURIComponent(
        selectedIncidentType
      )}&lat1=${intakeForm.pickupLat}&lng1=${intakeForm.pickupLng}&lat2=${intakeForm.dropoffLat}&lng2=${intakeForm.dropoffLng}${verifiedParam}`;
      const res = await apiFetch(url);
      const data = await res.json();
      setEligibility(data);

      if (showPopupOnViolation && data && effectivePid > 0) {
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
    if (currentUser?.sessionToken) {
      checkEligibility(false);
    }
  }, [
    currentUser?.sessionToken,
    intakeForm.hasInsurance,
    selectedPolicyId,
    selectedIncidentType,
    intakeForm.pickupLat,
    intakeForm.pickupLng,
    intakeForm.dropoffLat,
    intakeForm.dropoffLng,
    intakeForm.verifiedRoadDistanceKm
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
    setSelectedVehicleId('');
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
      verifiedRoadDistanceKm: '',
      isOutsourced: false,
      subcontractorId: 1,
      subcontractorFee: 65.0,
      assignedTruckId: '',
      prioritySequence: 10,
      cashCollected: 0,
      extraKmRate: 2.5,
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

  // Submit Call Intake (Supports Save Draft, Pending Insurance, and Approve & Dispatch)
  const handleCreateTowRequest = async (
    e,
    autoApproveDispatch = false,
    initialStatusOverride = 'Draft'
  ) => {
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
    const chosenTruckId = intakeForm.isOutsourced
      ? null
      : intakeForm.assignedTruckId
      ? Number(intakeForm.assignedTruckId)
      : autoApproveDispatch
      ? dashboard?.trucks?.find(t => t.fleetStatus === 'Available')?.truckId || 1
      : null;

    const verifiedRoadVal =
      intakeForm.verifiedRoadDistanceKm && Number(intakeForm.verifiedRoadDistanceKm) > 0
        ? Number(intakeForm.verifiedRoadDistanceKm)
        : null;

    try {
      const res = await apiFetch(`${API_BASE}/tow-requests`, {
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
          policyId:
            intakeForm.hasInsurance !== false && selectedPolicyId
              ? Number(selectedPolicyId)
              : null,
          isOutsourced: intakeForm.isOutsourced,
          subcontractorId: intakeForm.isOutsourced
            ? Number(intakeForm.subcontractorId || 1)
            : null,
          subcontractorFee: intakeForm.isOutsourced ? Number(intakeForm.subcontractorFee) : 0,
          assignedTruckId: chosenTruckId,
          autoApprove: Boolean(autoApproveDispatch),
          initialStatus: initialStatusOverride || 'Draft',
          verifiedRoadDistanceKm: verifiedRoadVal
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

  // Normalized 3NF Driver Profile Update (touches ONLY 1 row in dbo.Drivers)
  const handleSaveDriverContact = async e => {
    e.preventDefault();
    if (!editingDriver) return;
    try {
      const res = await apiFetch(`${API_BASE}/drivers/${editingDriver.driverId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: editingDriver.phone,
          isWorkingOffDay: Boolean(editingDriver.isWorkingOffDay),
          fullName: editingDriver.fullName,
          licenseNumber: editingDriver.licenseNumber,
          baseMonthlySalary: Number(editingDriver.baseMonthlySalary),
          overtimeRatePerTow: Number(editingDriver.overtimeRatePerTow),
          driverStatus: editingDriver.driverStatus
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Driver update failed');
      showToast('success', 'Driver Updated (3NF)', data.message);
      await fetchDashboard();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Driver Update Error', err.message);
    }
  };

  // Create New Normalized Driver in dbo.Drivers
  const handleCreateDriver = async e => {
    e.preventDefault();
    try {
      const res = await apiFetch(`${API_BASE}/drivers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeCode: newDriverForm.employeeCode,
          fullName: newDriverForm.fullName,
          phone: newDriverForm.phone,
          licenseNumber: newDriverForm.licenseNumber,
          baseMonthlySalary: Number(newDriverForm.baseMonthlySalary),
          overtimeRatePerTow: Number(newDriverForm.overtimeRatePerTow),
          isWorkingOffDay: Boolean(newDriverForm.isWorkingOffDay),
          driverStatus: newDriverForm.driverStatus
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Driver creation failed');
      showToast('success', 'Driver Registered', data.message);
      await fetchDashboard();
      setDriverViewMode('list');
      setNewDriverForm(prev => ({
        ...prev,
        employeeCode: `DRV-${Math.floor(112 + Math.random() * 800)}`,
        fullName: '',
        phone: '+961-70-',
        licenseNumber: `LB-COM-${Math.floor(1000 + Math.random() * 9000)}`
      }));
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Create Driver Error', err.message);
    }
  };

  // Create New Normalized Tow Truck in dbo.TowTrucks
  const handleCreateTruck = async e => {
    e.preventDefault();
    try {
      const res = await apiFetch(`${API_BASE}/trucks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          truckCode: newTruckForm.truckCode,
          licensePlate: newTruckForm.licensePlate,
          truckModel: newTruckForm.truckModel,
          maxPayloadKg: Number(newTruckForm.maxPayloadKg),
          currentLat: Number(newTruckForm.currentLat),
          currentLng: Number(newTruckForm.currentLng),
          fleetStatus: newTruckForm.fleetStatus
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Tow truck registration failed');
      showToast('success', 'Tow Truck Registered', data.message);
      await fetchDashboard();
      setTruckViewMode('list');
      setNewTruckForm(prev => ({
        ...prev,
        truckCode: `TRK-BEY-${Math.floor(10 + Math.random() * 89)}`,
        licensePlate: `P ${Math.floor(510000 + Math.random() * 89000)}`
      }));
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Register Truck Error', err.message);
    }
  };

  // Update Normalized Tow Truck in dbo.TowTrucks
  const handleSaveTruck = async e => {
    e.preventDefault();
    if (!selectedTruckForm) return;
    try {
      const res = await apiFetch(`${API_BASE}/trucks/${selectedTruckForm.truckId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          truckCode: selectedTruckForm.truckCode,
          licensePlate: selectedTruckForm.licensePlate,
          truckModel: selectedTruckForm.truckModel,
          maxPayloadKg: Number(selectedTruckForm.maxPayloadKg),
          currentLat: Number(selectedTruckForm.currentLat),
          currentLng: Number(selectedTruckForm.currentLng),
          fleetStatus: selectedTruckForm.fleetStatus
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Tow truck update failed');
      showToast('success', 'Tow Truck Updated (3NF)', data.message);
      await fetchDashboard();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Update Truck Error', err.message);
    }
  };

  // End an Active Driver-Truck Shift (Standby)
  const handleEndAssignment = async assignmentId => {
    try {
      const res = await apiFetch(`${API_BASE}/driver-assignments/${assignmentId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endNotes: 'Shift closed to Standby via Configuration console' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to end shift');
      showToast('success', 'Shift Ended to Standby', data.message);
      await fetchDashboard();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Assignment Error', err.message);
    }
  };

  // Update Normalized Customer in dbo.Customers
  const handleSaveCustomerEdit = async e => {
    e.preventDefault();
    if (!editingCustomerForm) return;
    try {
      const res = await apiFetch(`${API_BASE}/customers/${editingCustomerForm.customerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: editingCustomerForm.fullName,
          phone: editingCustomerForm.phone,
          email: editingCustomerForm.email
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Customer update failed');
      showToast('success', 'Customer Updated (3NF)', data.message);
      setEditingCustomerForm(null);
      await fetchDashboard();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Customer Update Error', err.message);
    }
  };

  // Normalized Driver-to-Truck Assignment Rotation (preserves StartDate/EndDate history)
  const handleAssignDriverToTruck = async (e, overrideDriverId, overrideTruckId) => {
    if (e) e.preventDefault();
    const dId = Number(overrideDriverId || assignDriverForm.driverId);
    const tId = Number(overrideTruckId || assignDriverForm.truckId);
    try {
      const res = await apiFetch(`${API_BASE}/driver-assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          driverId: dId,
          truckId: tId,
          assignmentNotes: assignDriverForm.assignmentNotes
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Assignment rotation failed');
      showToast('success', 'Truck Assignment Rotated', data.message);
      await fetchDashboard();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Assignment Error', err.message);
    }
  };

  // Publish New Historical Tariff (locks historical TowInvoices at original rates)
  const handleCreateTariff = async e => {
    e.preventDefault();
    try {
      const res = await apiFetch(`${API_BASE}/tariffs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tariffCode: newTariffForm.tariffCode,
          tariffName: newTariffForm.tariffName,
          serviceCategory: newTariffForm.serviceCategory,
          baseFee: Number(newTariffForm.baseFee),
          pricePerKm: Number(newTariffForm.pricePerKm),
          nightSurcharge: Number(newTariffForm.nightSurcharge),
          effectiveFrom: newTariffForm.effectiveFrom
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Tariff creation failed');
      showToast('success', 'New Tariff Published', data.message);
      setNewTariffForm(prev => ({
        ...prev,
        tariffCode: `TRF-2026-${Math.floor(100 + Math.random() * 900)}`
      }));
      await fetchDashboard();
      await checkEligibility(false);
      setTariffViewMode('list');
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Tariff Error', err.message);
    }
  };

  // Record Partial or Full Payment Row in dbo.InvoicePayments (Insurer vs Customer)
  const handleRecordInvoicePayment = async e => {
    e.preventDefault();
    if (!paymentModalInvoice) return;
    try {
      const res = await apiFetch(`${API_BASE}/invoices/${paymentModalInvoice.invoiceId}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payerType: paymentForm.payerType,
          amountPaid: Number(paymentForm.amountPaid),
          paymentMethod: paymentForm.paymentMethod,
          referenceNumber: paymentForm.referenceNumber,
          collectedByDriverId:
            paymentForm.payerType === 'Customer' && paymentForm.collectedByDriverId
              ? Number(paymentForm.collectedByDriverId)
              : null,
          notes: paymentForm.notes
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Payment failed');
      showToast('success', 'Payment Recorded in InvoicePayments', data.message);
      setPaymentModalInvoice(null);
      await fetchDashboard();
    } catch (err) {
      showToast('error', 'Payment Validation Blocked', err.message);
    }
  };

  // Add New Plate Letter
  const handleAddPlateCode = async e => {
    e.preventDefault();
    if (!newPlateLetter.trim()) return;
    try {
      const res = await apiFetch(`${API_BASE}/plate-codes`, {
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
      const res = await apiFetch(`${API_BASE}/quota-tiers/${tier.quotaTierId}`, {
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
      const res = await apiFetch(`${API_BASE}/policies/${selectedPolicyId}/tiers`, {
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

  // Switch Selected Customer (1:N: automatically selects first policy & registered vehicle of that customer)
  const handleSelectCustomer = custId => {
    const cid = Number(custId);
    setSelectedCustomerId(cid);
    setNewPolicyForm(prev => ({ ...prev, customerId: cid }));
    const custPolicies = (dashboard?.policies || []).filter(p => p.customerId === cid);
    const custVehicles = (dashboard?.vehicles || []).filter(v => v.customerId === cid);
    const firstVeh = custVehicles[0] || null;

    if (firstVeh) {
      setSelectedVehicleId(String(firstVeh.vehicleId));
    } else {
      setSelectedVehicleId('');
    }

    setIntakeForm(prev => ({
      ...prev,
      hasInsurance: custPolicies.length > 0,
      ...(firstVeh
        ? {
            noPlate: Boolean(firstVeh.noPlate),
            plateCodeId: firstVeh.plateCodeId || 2,
            plateDigits: firstVeh.plateDigits || '',
            vehicleDesc: firstVeh.vehicleModel || ''
          }
        : {})
    }));

    if (custPolicies.length > 0) {
      setSelectedPolicyId(custPolicies[0].policyId);
    } else {
      setSelectedPolicyId(0);
    }
  };

  // Register Standalone Customer in dbo.Customers
  const handleCreateCustomer = async e => {
    e.preventDefault();
    try {
      const res = await apiFetch(`${API_BASE}/customers`, {
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
      const res = await apiFetch(`${API_BASE}/policies`, {
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
      const res = await apiFetch(`${API_BASE}/tow-requests/${towRequestId}/dispatch`, {
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
      showToast('error', 'Dispatch Authorization Blocked', err.message);
    }
  };

  // Update Lifecycle Status
  const handleLifecycleChange = async (towRequestId, newStatus) => {
    try {
      const res = await apiFetch(`${API_BASE}/tow-requests/${towRequestId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newStatus,
          cashCollected: newStatus === 'Done' ? 15.0 : 0.0,
          rejectionReason: newStatus === 'Rejected' ? 'Rejected by dispatcher' : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Status transition rejected');
      showToast('success', `Status → ${newStatus}`, data.message);
      await fetchDashboard();
    } catch (err) {
      showToast('error', 'Ticket Lifecycle Restriction', err.message);
    }
  };

  // Verify Compliance Lock on Finalized Ticket
  const handleTestTriggerLock = async towRequestId => {
    try {
      const res = await apiFetch(
        `${API_BASE}/tow-requests/${towRequestId}/test-immutability-trigger`,
        { method: 'POST' }
      );
      const data = await res.json();
      if (data.blockedByTrigger) {
        showToast(
          'error',
          `Compliance Seal Active (Code ${data.sqlErrorNumber})`,
          data.triggerMessage
        );
      } else {
        showToast('success', 'Compliance Seal Verified', data.message);
      }
    } catch (err) {
      showToast('error', 'Compliance Check Failed', err.message);
    }
  };

  // Reorder Truck Priority Queue (Earlier / Later)
  const handleReorderQueue = async (truckId, towRequestId, direction) => {
    try {
      const res = await apiFetch(`${API_BASE}/trucks/${truckId}/reorder-queue`, {
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
      const res = await apiFetch(`${API_BASE}/concurrency/simulate-race`, {
        method: 'POST'
      });
      const data = await res.json();
      setConcurrencyResult(data);
      await fetchDashboard();
    } catch (err) {
      showToast('error', 'Multi-Desk Sync Check Failed', err.message);
    } finally {
      setConcurrencyRunning(false);
    }
  };

  // Revision Token Update
  const handleOptimisticUpdate = async (reqObj, forceStaleToken = false) => {
    try {
      const tokenToSend = forceStaleToken ? '0x0000000000000001' : reqObj.rowVerHex;
      const res = await apiFetch(`${API_BASE}/tow-requests/${reqObj.towRequestId}/optimistic-edit`, {
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
        showToast('success', 'Ticket Notes Updated', data.message);
        await fetchDashboard();
      } else {
        showToast('error', 'Concurrent Edit Conflict Prevented', data.error);
      }
    } catch (err) {
      showToast('error', 'Ticket Update Error', err.message);
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
      const res = await apiFetch(url);
      const data = await res.json();
      setPerfResult(data);
    } catch (err) {
      showToast('error', 'Performance Query Error', err.message);
    } finally {
      setPerfLoading(false);
    }
  };

  // Admin RBAC Role Preset Helper
  const getRolePermissionPreset = role => {
    if (role === 'Admin') {
      return {
        canDispatch: true,
        canManageFleet: true,
        canManagePolicies: true,
        canManageBilling: true,
        canManageUsers: true
      };
    }
    if (role === 'FleetManager') {
      return {
        canDispatch: true,
        canManageFleet: true,
        canManagePolicies: false,
        canManageBilling: false,
        canManageUsers: false
      };
    }
    if (role === 'Underwriter') {
      return {
        canDispatch: false,
        canManageFleet: false,
        canManagePolicies: true,
        canManageBilling: true,
        canManageUsers: false
      };
    }
    return {
      canDispatch: true,
      canManageFleet: false,
      canManagePolicies: true,
      canManageBilling: true,
      canManageUsers: false
    };
  };

  const fetchUserGroups = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/admin/user-groups`);
      const data = await res.json();
      if (res.ok && data.groups) {
        setUserGroups(data.groups);
      }
    } catch {
      // ignore
    }
  };

  const fetchAdminUsers = async () => {
    setAdminLoading(true);
    try {
      await fetchUserGroups();
      const res = await apiFetch(`${API_BASE}/admin/users`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load system users');
      setAdminUsers(data.users || []);
    } catch (err) {
      showToast('error', 'User Administration Access', err.message);
    } finally {
      setAdminLoading(false);
    }
  };

  // Fetch Section-Only Change Logs (strictly scoped to the active section)
  const fetchChangeLogs = async () => {
    if (!currentUser || !CHANGE_LOG_SECTIONS[activeTab]) return;
    setChangeLogLoading(true);
    try {
      const params = new URLSearchParams({
        section: activeTab,
        top: '100'
      });
      const res = await apiFetch(`${API_BASE}/changelogs?${params.toString()}`);
      const data = await res.json();
      if (res.ok && data.logs) {
        setChangeLogs(data.logs);
      }
    } catch {
      // ignore background poll errors
    } finally {
      setChangeLogLoading(false);
    }
  };

  // Fetch Full 3NF Tow Request Info + Invoice Payments + Unified Odoo Change Log (works for all 120,000+ rows)
  const fetchTowRequestDetail = async towRequestId => {
    if (!currentUser || !towRequestId) return;
    setTowDetailLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/tow-requests/${Number(towRequestId)}`);
      const data = await res.json();
      if (res.ok && data.tow) {
        setTowDetailData({
          tow: data.tow,
          payments: data.payments || [],
          logs: data.logs || []
        });
      }
    } catch (err) {
      showToast('error', 'Tow Info Lookup Failed', err.message);
    } finally {
      setTowDetailLoading(false);
    }
  };

  // Resolve Currently Open Single Record (for Inline Odoo Chatter inside Info Views)
  const getActiveInlineRecordTarget = () => {
    if (activeTab === 'users' && userViewMode === 'form' && editingUser) {
      return { entityType: 'SystemUsers', entityId: editingUser.userId, label: editingUser.username };
    }
    if (activeTab === 'groups' && groupViewMode === 'form' && editingGroup) {
      return { entityType: 'UserGroups', entityId: editingGroup.groupId, label: editingGroup.groupCode };
    }
    if (activeTab === 'trucks' && truckViewMode === 'form' && selectedTruckForm) {
      return { entityType: 'TowTrucks', entityId: selectedTruckForm.truckId, label: selectedTruckForm.truckCode };
    }
    if (activeTab === 'drivers' && driverViewMode === 'form' && editingDriver) {
      return { entityType: 'Drivers', entityId: editingDriver.driverId, label: editingDriver.employeeCode };
    }
    if (activeTab === 'customers' && customerViewMode === 'form' && selectedCustomerId) {
      return { entityType: 'Customers', entityId: Number(selectedCustomerId), label: `Customer #${selectedCustomerId}` };
    }
    if (activeTab === 'policies' && policyViewMode === 'form' && selectedPolicyId) {
      return { entityType: 'InsurancePolicies', entityId: Number(selectedPolicyId), label: `Policy #${selectedPolicyId}` };
    }
    if (activeTab === 'tariffs' && tariffViewMode === 'form' && selectedTariffId) {
      return { entityType: 'Tariffs', entityId: Number(selectedTariffId), label: `Tariff #${selectedTariffId}` };
    }
    if (activeTab === 'billing' && invoiceViewMode === 'form' && selectedInvoiceId) {
      return { entityType: 'TowInvoices', entityId: Number(selectedInvoiceId), label: `Invoice #${selectedInvoiceId}` };
    }
    return null;
  };

  const fetchRecordInlineLogs = async targetOverride => {
    const target = targetOverride || getActiveInlineRecordTarget();
    if (!currentUser || !target) return;
    setRecordInlineLogsLoading(true);
    try {
      const params = new URLSearchParams({
        entityType: target.entityType,
        entityId: String(target.entityId),
        top: '50'
      });
      const res = await apiFetch(`${API_BASE}/changelogs?${params.toString()}`);
      const data = await res.json();
      if (res.ok && data.logs) {
        setRecordInlineLogs(data.logs);
      }
    } catch {
      // ignore background poll errors
    } finally {
      setRecordInlineLogsLoading(false);
    }
  };

  // Cross-Entity Normalized Navigation Helpers (Jump between related 3NF records!)
  const openUserGroupRecord = groupId => {
    const g = userGroups.find(x => x.groupId === Number(groupId));
    if (!g) return;
    setEditingGroup({ ...g });
    setGroupViewMode('form');
    setActiveTab('groups');
  };

  const openUserRecord = userId => {
    const u = adminUsers.find(x => x.userId === Number(userId));
    if (!u) return;
    setEditingUser({ ...u, newPassword: '' });
    setUserNotebookTab('tows');
    setUserViewMode('form');
    setActiveTab('users');
  };

  const openTruckRecord = truckId => {
    const t = (dashboard?.trucks || []).find(x => x.truckId === Number(truckId));
    if (!t) return;
    setSelectedTruckForm({ ...t });
    setTruckNotebookTab('assignments');
    setTruckViewMode('form');
    setActiveTab('trucks');
  };

  const openDriverRecord = driverId => {
    const d = (dashboard?.drivers || []).find(x => x.driverId === Number(driverId));
    if (!d) return;
    setEditingDriver({ ...d });
    setDriverNotebookTab('assignments');
    setDriverViewMode('form');
    setActiveTab('drivers');
  };

  const openCustomerRecord = customerId => {
    handleSelectCustomer(customerId);
    setEditingCustomerForm(null);
    setCustomerNotebookTab('policies');
    setCustomerViewMode('form');
    setActiveTab('customers');
  };

  const openPolicyRecord = policyId => {
    setSelectedPolicyId(Number(policyId));
    setPolicyNotebookTab('tiers');
    setPolicyViewMode('form');
    setActiveTab('policies');
  };

  const openTariffRecord = tariffId => {
    setSelectedTariffId(Number(tariffId));
    setTariffViewMode('form');
    setActiveTab('tariffs');
  };

  const openInvoiceRecord = invoiceId => {
    setSelectedInvoiceId(Number(invoiceId));
    setInvoiceViewMode('form');
    setActiveTab('billing');
  };

  const openTowRequestRecord = (towRequestId, stayOnArchive = false) => {
    const numId = Number(towRequestId);
    setSelectedTowRequestId(numId);
    setTowDetailNotebookTab('invoice');
    if (towDetailData?.tow?.towRequestId !== numId) {
      setTowDetailData(null);
    }
    fetchTowRequestDetail(numId);
    if (stayOnArchive) {
      setArchiveViewMode('detail');
    } else {
      setQueueViewMode('detail');
      setActiveTab('queue');
    }
  };

  const handleCreateUserGroup = async e => {
    e.preventDefault();
    try {
      const res = await apiFetch(`${API_BASE}/admin/user-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newGroupForm)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user group');
      showToast('success', 'User Group Created', data.message);
      await fetchUserGroups();
      setGroupViewMode('list');
      setNewGroupForm(prev => ({
        ...prev,
        groupCode: `GROUP_${Math.floor(10 + Math.random() * 89)}`,
        groupName: ''
      }));
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Create User Group Failed', err.message);
    }
  };

  const handleUpdateUserGroup = async e => {
    e.preventDefault();
    if (!editingGroup) return;
    try {
      const res = await apiFetch(`${API_BASE}/admin/user-groups/${editingGroup.groupId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupCode: editingGroup.groupCode,
          groupName: editingGroup.groupName,
          description: editingGroup.description,
          canDispatch: Boolean(editingGroup.canDispatch),
          canManageFleet: Boolean(editingGroup.canManageFleet),
          canManagePolicies: Boolean(editingGroup.canManagePolicies),
          canManageBilling: Boolean(editingGroup.canManageBilling),
          canManageUsers: Boolean(editingGroup.canManageUsers)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update user group');
      showToast('success', 'User Group Permissions Updated', data.message);
      await fetchAdminUsers();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Update User Group Failed', err.message);
    }
  };

  const handleDeleteUserGroup = async grp => {
    try {
      const res = await apiFetch(`${API_BASE}/admin/user-groups/${grp.groupId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete user group');
      showToast('success', 'User Group Deleted', data.message);
      setEditingGroup(null);
      setGroupViewMode('list');
      await fetchUserGroups();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Delete User Group Blocked', err.message);
    }
  };

  const handleAdminCreateUser = async e => {
    e.preventDefault();
    try {
      const res = await apiFetch(`${API_BASE}/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: newUserForm.username,
          password: newUserForm.password,
          fullName: newUserForm.fullName,
          roleTitle: newUserForm.roleTitle,
          department: newUserForm.department,
          stationCode: newUserForm.stationCode,
          groupId: Number(newUserForm.groupId || 2),
          isActive: Boolean(newUserForm.isActive)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create operator');
      showToast('success', 'Operator Created & Assigned to Group', data.message);
      setNewUserForm({
        username: '',
        password: '',
        fullName: '',
        roleTitle: 'Emergency Roadside Dispatcher',
        department: '24/7 Roadside Desk',
        stationCode: 'BEY-DSK-08',
        groupId: 2,
        isActive: true
      });
      await fetchAdminUsers();
      setUserViewMode('list');
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Create User Failed', err.message);
    }
  };

  const handleAdminUpdateUser = async e => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      const res = await apiFetch(`${API_BASE}/admin/users/${editingUser.userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: editingUser.fullName,
          roleTitle: editingUser.roleTitle,
          department: editingUser.department,
          stationCode: editingUser.stationCode,
          groupId: Number(editingUser.groupId),
          isActive: Boolean(editingUser.isActive),
          newPassword: editingUser.newPassword ? editingUser.newPassword : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update user & group assignment');
      showToast('success', 'User & Group Assignment Updated', data.message);
      setEditingUser(prev => (prev ? { ...prev, newPassword: '' } : null));
      await fetchAdminUsers();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Update User Failed', err.message);
    }
  };

  const handleAdminDeleteUser = async userObj => {
    try {
      const res = await apiFetch(`${API_BASE}/admin/users/${userObj.userId}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete user');
      showToast('success', 'Operator Account Removed / Revoked', data.message);
      if (editingUser?.userId === userObj.userId) {
        setEditingUser(null);
        setUserViewMode('list');
      }
      await fetchAdminUsers();
      if (changeLogOpen) await fetchChangeLogs();
    } catch (err) {
      showToast('error', 'Delete User Blocked', err.message);
    }
  };

  useEffect(() => {
    if (activeTab === 'performance' && !perfResult) {
      runPerformanceQuery('date_status', perfPlate);
    } else if ((activeTab === 'users' || activeTab === 'groups') && currentUser) {
      fetchAdminUsers();
    }
  }, [activeTab]);

  const activeInlineTarget = getActiveInlineRecordTarget();
  const activeInlineKey = activeInlineTarget
    ? `${activeInlineTarget.entityType}:${activeInlineTarget.entityId}`
    : '';

  useEffect(() => {
    if (activeInlineTarget && currentUser) {
      fetchRecordInlineLogs(activeInlineTarget);
    } else {
      setRecordInlineLogs([]);
    }
  }, [activeInlineKey, dashboard, adminUsers, userGroups]);

  useEffect(() => {
    if (
      currentUser &&
      selectedTowRequestId &&
      ((activeTab === 'queue' && queueViewMode === 'detail') ||
        (activeTab === 'performance' && archiveViewMode === 'detail'))
    ) {
      fetchTowRequestDetail(selectedTowRequestId);
    }
  }, [dashboard, selectedTowRequestId, activeTab, queueViewMode, archiveViewMode]);

  useEffect(() => {
    setChangeLogFilter('');
  }, [activeTab]);

  useEffect(() => {
    if (changeLogOpen && currentUser && CHANGE_LOG_SECTIONS[activeTab]) {
      fetchChangeLogs();
    }
  }, [changeLogOpen, activeTab]);

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
  const customerVehicles = (dashboard?.vehicles || []).filter(
    v => v.customerId === Number(selectedCustomerId)
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

  // Reusable Plain Odoo-Style Chatter Log Stream (zero decorative cards/badges/pills)
  const renderOdooLogEntries = (events, isLoading, emptyLabel) => {
    if (!events || events.length === 0) {
      return (
        <p className="o-chatter-note" style={{ padding: '10px 0' }}>
          {isLoading ? 'Loading change log...' : emptyLabel}
        </p>
      );
    }
    let lastDateGroup = '';
    return events.map(ev => {
      const rawStamp = String(ev.changedAt || '');
      const datePart = rawStamp.length >= 10 ? rawStamp.slice(0, 10) : 'Recent';
      const timePart = rawStamp.length >= 19 ? rawStamp.slice(11, 19) : rawStamp;
      const showDateSep = datePart !== lastDateGroup;
      lastDateGroup = datePart;

      const op = String(ev.operationType || 'UPDATE').toUpperCase();
      const details = ev.details || [];

      return (
        <React.Fragment key={ev.changeEventId}>
          {showDateSep && <div className="o-chatter-date-sep">{datePart}</div>}
          <div className="o-chatter-message">
            <div className="o-chatter-msg-head">
              <div>
                <span className="o-chatter-author">
                  {ev.changedByFullName || ev.changedByUsername || 'System'}
                </span>{' '}
                <span className="o-chatter-record-ref">
                  ({ev.changedByUsername || 'system'})
                  {ev.entityCode ? ` · ${ev.entityCode}` : ''}
                </span>
              </div>
              <span className="o-chatter-time">{timePart}</span>
            </div>

            {op === 'CREATE' && <div className="o-chatter-note">Record created</div>}
            {op === 'DELETE' && <div className="o-chatter-note">Record deleted</div>}

            {details.length > 0 && (
              <ul className="o-chatter-tracking-list">
                {details.map(d => {
                  const oldText =
                    d.oldValue !== null && d.oldValue !== undefined && d.oldValue !== ''
                      ? String(d.oldValue)
                      : 'None';
                  const newText =
                    d.newValue !== null && d.newValue !== undefined && d.newValue !== ''
                      ? String(d.newValue)
                      : 'None';

                  if (op === 'CREATE') {
                    return (
                      <li key={d.changeDetailId}>
                        <span className="o-chatter-field">{d.fieldName}:</span>{' '}
                        <span className="o-chatter-new">{newText}</span>
                      </li>
                    );
                  }
                  if (op === 'DELETE') {
                    return (
                      <li key={d.changeDetailId}>
                        <span className="o-chatter-field">{d.fieldName}:</span>{' '}
                        <span className="o-chatter-old">{oldText}</span>
                      </li>
                    );
                  }
                  return (
                    <li key={d.changeDetailId}>
                      <span className="o-chatter-field">{d.fieldName}:</span>{' '}
                      <span className="o-chatter-old">{oldText}</span>
                      <span className="o-chatter-arrow">→</span>
                      <span className="o-chatter-new">{newText}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </React.Fragment>
      );
    });
  };

  // Inline Odoo Chatter Block rendered directly inside Record Info Sheets
  const renderInlineRecordChatter = label => (
    <div className="o-inline-chatter">
      <div className="o-inline-chatter-head">
        <span className="o-inline-chatter-title">Change Log — {label}</span>
        <button
          type="button"
          className="o-chatter-btn"
          onClick={() => fetchRecordInlineLogs()}
        >
          {recordInlineLogsLoading ? '...' : 'Refresh'}
        </button>
      </div>
      {renderOdooLogEntries(
        recordInlineLogs,
        recordInlineLogsLoading,
        `No changes logged yet for ${label}.`
      )}
    </div>
  );

  // Full 3NF Tow Request Info Sheet + Embedded Odoo Change Log (works for all 120,000+ rows)
  const renderTowDetailSheet = (backLabel, onBack) => {
    const r =
      towDetailData?.tow?.towRequestId === Number(selectedTowRequestId)
        ? towDetailData.tow
        : (dashboard?.recentRequests || []).find(
            x => x.towRequestId === Number(selectedTowRequestId)
          );

    if (!r) {
      return (
        <div style={{ padding: '18px 0' }}>
          <button type="button" className="btn-erp-secondary" onClick={onBack}>
            {backLabel}
          </button>
          <p className="muted" style={{ marginTop: '14px' }}>
            {towDetailLoading
              ? `Loading Tow Request #${selectedTowRequestId} info & change log...`
              : 'Tow request details not available.'}
          </p>
        </div>
      );
    }

    const payments = towDetailData?.payments || [];
    const logs = towDetailData?.logs || [];

    return (
      <div style={{ marginTop: '8px' }}>
        <div className="o-form-statusbar" style={{ borderRadius: '8px', marginBottom: '14px' }}>
          <button type="button" className="btn-erp-secondary" onClick={onBack}>
            {backLabel}
          </button>
          <div className="o-statusbar-status">
            <span className="o-stage-pill current">{r.status}</span>
          </div>
        </div>

        <div className="erp-oe-title">
          <span className="erp-oe-label">
            dbo.TowRequests #{r.towRequestId} • Created {r.createdAt}
            {r.completedAt ? ` • Completed ${r.completedAt}` : ''}
          </span>
          <h1>{r.requestNumber}</h1>
        </div>

        <div className="erp-group-grid">
          <div className="erp-group-col">
            <div className="erp-group-header">CALLER, VEHICLE &amp; INSURANCE COVERAGE</div>
            <div className="erp-field-row">
              <label>Customer</label>
              <div className="erp-field-val">
                <button
                  type="button"
                  className="rel-entity-link"
                  onClick={() => openCustomerRecord(r.customerId)}
                >
                  {r.customerName} ({r.customerPhone || r.callerPhone})
                </button>
              </div>
            </div>
            <div className="erp-field-row">
              <label>Vehicle</label>
              <div className="erp-field-val">
                <code>{r.vehiclePlate}</code> — <strong>{r.vehicleModel}</strong>
                {r.plateRegionDescription ? (
                  <small className="muted"> ({r.plateRegionDescription})</small>
                ) : null}
              </div>
            </div>
            <div className="erp-field-row">
              <label>Insurance Policy</label>
              <div className="erp-field-val">
                {r.policyId ? (
                  <>
                    <button
                      type="button"
                      className="rel-entity-link"
                      onClick={() => openPolicyRecord(r.policyId)}
                    >
                      {r.policyNumber}
                    </button>
                    {r.providerName ? <span> • {r.providerName}</span> : null}
                  </>
                ) : (
                  <span className="muted">Uninsured / Direct Customer Billing</span>
                )}
              </div>
            </div>
            {r.quotaTierId ? (
              <div className="erp-field-row">
                <label>Quota Tier</label>
                <div className="erp-field-val">
                  Tier #{r.tierSequence} ({r.tierCoverageType}) — {r.tierUsedTows}/{r.tierAllowedTows}{' '}
                  used • Cap {r.tierMaxDistanceKm} km
                </div>
              </div>
            ) : null}
            <div className="erp-field-row">
              <label>Breakdown Type</label>
              <div className="erp-field-val">
                <strong>{r.issueType}</strong>
                {r.isNightShift ? ' • Night Shift (19:00–07:00)' : ' • Standard Day Shift'}
              </div>
            </div>
            {r.issueNotes ? (
              <div className="erp-field-row">
                <label>Dispatch Notes</label>
                <div className="erp-field-val">{r.issueNotes}</div>
              </div>
            ) : null}
          </div>

          <div className="erp-group-col">
            <div className="erp-group-header">FLEET ASSIGNMENT, ROUTE &amp; SPLIT INVOICE</div>
            <div className="erp-field-row">
              <label>Assigned Tow Truck</label>
              <div className="erp-field-val">
                {r.assignedTruckId ? (
                  <>
                    <button
                      type="button"
                      className="rel-entity-link"
                      onClick={() => openTruckRecord(r.assignedTruckId)}
                    >
                      {r.truckCode}
                    </button>
                    {r.truckModel ? (
                      <small className="muted">
                        {' '}
                        ({r.truckModel} • {r.truckPlate})
                      </small>
                    ) : null}
                  </>
                ) : r.subcontractorId || r.subcontractorName ? (
                  <span>
                    Outsourced: <strong>{r.subcontractorName}</strong>
                    {r.subcontractorPhone ? ` (${r.subcontractorPhone})` : ''}
                  </span>
                ) : (
                  <span className="muted">Unassigned</span>
                )}
              </div>
            </div>
            <div className="erp-field-row">
              <label>Assigned Driver</label>
              <div className="erp-field-val">
                {r.assignedDriverId ? (
                  <button
                    type="button"
                    className="rel-entity-link"
                    onClick={() => openDriverRecord(r.assignedDriverId)}
                  >
                    {r.driverName || r.assignedDriverName}
                    {r.driverCode ? ` (${r.driverCode})` : ''}
                  </button>
                ) : (
                  <span className="muted">—</span>
                )}
              </div>
            </div>
            <div className="erp-field-row">
              <label>Pickup → Dropoff</label>
              <div className="erp-field-val">
                {r.pickupAddress} → {r.destinationAddress}
              </div>
            </div>
            <div className="erp-field-row">
              <label>Road Distance</label>
              <div className="erp-field-val">
                <strong>{r.actualDistanceKm} km</strong>{' '}
                <small className="muted">
                  ({r.distanceSource} • Geodesic: {r.straightLineDistanceKm} km)
                </small>
              </div>
            </div>
            <div className="erp-field-row">
              <label>Linked Invoice</label>
              <div className="erp-field-val">
                {r.invoiceId > 0 ? (
                  <div>
                    <button
                      type="button"
                      className="rel-entity-link"
                      onClick={() => openInvoiceRecord(r.invoiceId)}
                    >
                      {r.invoiceNumber || `Invoice #${r.invoiceId}`} (${r.totalInvoiceAmount} •{' '}
                      {r.invoiceStatus})
                    </button>
                    {r.tariffCode ? (
                      <div className="muted" style={{ fontSize: '12px', marginTop: '3px' }}>
                        Tariff <code>{r.tariffCode}</code>: Base ${r.appliedBaseFee} + $
                        {r.appliedPricePerKm}/km
                        {Number(r.appliedNightSurcharge) > 0
                          ? ` + Night $${r.appliedNightSurcharge}`
                          : ''}{' '}
                        | Insurer: ${r.insurerBilledAmount} (Paid ${r.insurerPaidAmount}) • Customer: $
                        {r.customerBilledAmount} (Paid ${r.customerPaidAmount})
                      </div>
                    ) : null}
                  </div>
                ) : (
                  '—'
                )}
              </div>
            </div>
          </div>
        </div>

        {payments.length > 0 && (
          <div className="erp-notebook" style={{ marginTop: '14px' }}>
            <div className="erp-notebook-tabs">
              <button type="button" className="erp-nb-tab active">
                Invoice Payments ({payments.length})
              </button>
            </div>
            <div className="erp-notebook-page">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Paid At</th>
                    <th>Payer</th>
                    <th>Method &amp; Reference</th>
                    <th>Recorded By</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(pm => (
                    <tr key={pm.paymentId}>
                      <td>{pm.paidAt}</td>
                      <td>
                        {pm.payerType} — <strong>{pm.payerName}</strong>
                      </td>
                      <td>
                        {pm.paymentMethod}
                        {pm.referenceNumber ? ` • ${pm.referenceNumber}` : ''}
                      </td>
                      <td>
                        {pm.recordedByFullName} ({pm.recordedByUsername})
                      </td>
                      <td>
                        <strong>${pm.amountPaid}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="o-inline-chatter">
          <div className="o-inline-chatter-head">
            <span className="o-inline-chatter-title">
              Change Log — {r.requestNumber}
            </span>
            <button
              type="button"
              className="o-chatter-btn"
              onClick={() => fetchTowRequestDetail(r.towRequestId)}
            >
              {towDetailLoading ? '...' : 'Refresh'}
            </button>
          </div>
          {renderOdooLogEntries(
            logs,
            towDetailLoading,
            `No changes logged yet for ${r.requestNumber}.`
          )}
        </div>
      </div>
    );
  };

  // ============================================================================
  // MODERN SOLAR-AMBER & OBSIDIAN HERO + OPERATOR COMMAND LOGIN PORTAL
  // ============================================================================
  if (!currentUser) {
    const operatorProfiles = [
      {
        username: 'assaad.khalife',
        name: 'Assaad Khalife',
        role: 'Chief Operations & CAD Director',
        station: 'BEY-CMD-01'
      },
      {
        username: 'dispatch.beirut',
        name: 'Rami Nassar',
        role: 'Senior Emergency Dispatcher',
        station: 'BEY-DSK-04'
      },
      {
        username: 'fleet.manager',
        name: 'Karim Haddad',
        role: 'Fleet & Recovery Supervisor',
        station: 'BEY-FLT-02'
      },
      {
        username: 'claims.underwriter',
        name: 'Maya Khoury',
        role: 'Insurance Policy Specialist',
        station: 'BEY-INS-01'
      }
    ];

    return (
      <div className="modern-landing-shell" id="top">
        {/* STAGE 1: VIBRANT SOLAR-AMBER HERO + FLOATING OBSIDIAN LOGIN CARD */}
        <div className="solar-hero-stage">
          {/* Geometric Constellation / Telemetry Network SVG Overlay */}
          <svg
            className="hero-constellation-svg"
            viewBox="0 0 1440 900"
            fill="none"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden="true"
          >
            <g stroke="rgba(255,255,255,0.24)" strokeWidth="1.15">
              <line x1="180" y1="150" x2="430" y2="95" />
              <line x1="430" y1="95" x2="620" y2="230" />
              <line x1="180" y1="150" x2="310" y2="340" />
              <line x1="310" y1="340" x2="620" y2="230" />
              <line x1="620" y1="230" x2="880" y2="175" />
              <line x1="880" y1="175" x2="1040" y2="330" />
              <line x1="590" y1="640" x2="870" y2="730" />
              <line x1="870" y1="730" x2="1120" y2="620" />
              <line x1="210" y1="680" x2="460" y2="760" />
              <line x1="460" y1="760" x2="590" y2="640" />
            </g>
            <g fill="#12C2E9">
              <circle cx="430" cy="95" r="4.5" />
              <circle cx="180" cy="150" r="3.5" />
              <circle cx="620" cy="230" r="4" />
              <circle cx="880" cy="175" r="4.5" />
              <circle cx="590" cy="640" r="4.5" />
              <circle cx="870" cy="730" r="3.5" />
              <circle cx="210" cy="680" r="4" />
            </g>
          </svg>

          {/* Top Minimalist Editorial Header */}
          <header className="solar-top-nav">
            <div className="solar-nav-left">
              <a href="#top" className="solar-brand">
                <span className="solar-brand-mark" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 3a9 9 0 1 0 9 9"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                    />
                    <path
                      d="M12 7v5l3.5 3.5"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <circle cx="19" cy="5" r="2.5" fill="currentColor" />
                  </svg>
                </span>
                <span className="solar-brand-text">
                  TRACKER <em>Connect™</em>
                </span>
              </a>

              <nav className="solar-nav-links" aria-label="Landing sections">
                <a href="#top">Home</a>
                <a href="#fleetlogic">FleetLogic™</a>
                <a href="#solutions">Roadside Assist</a>
                <a href="#insurers">Insurer Quotas</a>
              </nav>
            </div>

            <div className="solar-nav-right">
              <span className="solar-hotline">24/7 CAD • (+961) 01-401-999</span>
              <a href="#operator-login-card" className="solar-black-pill">
                Operator Portal
              </a>
            </div>
          </header>

          {/* Main Asymmetric Hero Grid */}
          <div className="solar-hero-grid">
            {/* Left / Center Kinetic 3D Showcase */}
            <div className="solar-showcase-col">
              {/* Vertical Scroll Cue */}
              <a href="#solutions" className="solar-scroll-cue" aria-label="Scroll to platform details">
                <span className="solar-scroll-label">Scroll</span>
                <span className="solar-scroll-line" aria-hidden="true">
                  <svg width="16" height="58" viewBox="0 0 16 58" fill="none">
                    <line x1="8" y1="0" x2="8" y2="52" stroke="currentColor" strokeWidth="1.8" />
                    <path
                      d="M2 46L8 53L14 46"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </a>

              <div className="solar-headline-stage">
                <div className="solar-eyebrow">
                  <span className="solar-live-dot"></span>
                  National GPS Telemetry &amp; Insurance CAD
                </div>

                {/* 3D Tow Truck Centerpiece + Overlapping Display Typography */}
                <div className="solar-visual-composition">
                  <h1 className="solar-display-title">
                    <span className="solar-title-top">Rocket</span>
                    <span className="solar-title-bottom">every rescue.</span>
                  </h1>

                  <div className="solar-3d-artwork-wrap">
                    <img
                      src="/hero-tow-3d.png"
                      alt="3D Roadside Recovery Tow Truck with Live GPS Telemetry Pin"
                      className="solar-3d-artwork"
                    />
                  </div>
                </div>

                <div className="solar-bottom-blurb">
                  <div className="solar-live-badges">
                    <span className="solar-chip-dark">Beirut • Mount Lebanon • North • Bekaa • South</span>
                    <span className="solar-chip-glass">24/7 Emergency Dispatch • National Fleet Network</span>
                  </div>

                  <div className="solar-how-it-works">
                    <h3>How does it work?</h3>
                    <p>
                      From emergency CTI call intake and OSRM road-distance routing to multi-policy
                      insurer quota verification, Tracker Connect™ unifies fleet dispatch and driver
                      settlement in real time.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Floating Obsidian Command Login Card */}
            <div className="obsidian-login-wrap" id="operator-login-card">
              <div className="obsidian-login-card">
                <div className="obsidian-login-pill-header">Operator Sign In</div>

                <div className="obsidian-login-intro">
                  <h2>Command Portal</h2>
                  <p>
                    Sign in with your assigned station credentials to access live GPS fleet
                    dispatch, CTI call intake, and policy underwriting controls.
                  </p>
                </div>

                {loginError && (
                  <div className="obsidian-login-error" role="alert">
                    {loginError}
                  </div>
                )}

                <form onSubmit={handleLoginSubmit} className="obsidian-login-form">
                  <div className="obsidian-field">
                    <label htmlFor="operator-username">Operator Username / ID</label>
                    <input
                      id="operator-username"
                      type="text"
                      placeholder="Enter operator ID"
                      value={loginForm.username}
                      onChange={e => setLoginForm({ ...loginForm, username: e.target.value })}
                      required
                    />
                  </div>

                  <div className="obsidian-field">
                    <div className="obsidian-label-row">
                      <label htmlFor="operator-password">Password</label>
                      <button
                        type="button"
                        className="obsidian-show-btn"
                        onClick={() => setShowPassword(prev => !prev)}
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <input
                      id="operator-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Enter portal password"
                      value={loginForm.password}
                      onChange={e => setLoginForm({ ...loginForm, password: e.target.value })}
                      required
                    />
                  </div>

                  <button type="submit" className="obsidian-submit-btn" disabled={loginLoading}>
                    {loginLoading
                      ? 'Authenticating...'
                      : 'Sign In'}
                  </button>
                </form>

                {/* Clean Enterprise Shift Desk Switcher + Capability Icons */}
                <div className="obsidian-card-footer">
                  <p className="obsidian-shift-prompt">
                    Assigned to a command desk?{' '}
                    <button
                      type="button"
                      className="obsidian-shift-toggle"
                      onClick={() => setShowStationSwitcher(prev => !prev)}
                    >
                      {showStationSwitcher ? 'Hide Stations ▴' : 'Select Station ID ▾'}
                    </button>
                  </p>

                  {showStationSwitcher && (
                    <div className="obsidian-operators-grid">
                      {operatorProfiles.map(op => (
                        <button
                          key={op.username}
                          type="button"
                          className={
                            loginForm.username === op.username
                              ? 'obsidian-op-chip active'
                              : 'obsidian-op-chip'
                          }
                          onClick={() => {
                            setLoginForm({ username: op.username, password: '' });
                            setLoginError('');
                          }}
                        >
                          <div className="obsidian-op-name">{op.name}</div>
                          <div className="obsidian-op-role">{op.role}</div>
                          <div className="obsidian-op-meta">
                            <code>{op.username}</code>
                            <span>{op.station}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="obsidian-protocol-strip" aria-label="Platform capabilities">
                    <span className="obsidian-proto-label">Connected Modules</span>
                    <div className="obsidian-proto-icons">
                      <span title="Live GPS Fleet CAD">GPS</span>
                      <span title="24/7 Emergency CTI Telephony">CTI</span>
                      <span title="Real-Time Road Routing">OSRM</span>
                      <span title="Insurer Policy Underwriting">SLA</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* STAGE 2: MIDNIGHT HORIZON PLATFORM CAPABILITIES SHOWCASE */}
        <section className="midnight-horizon-section" id="solutions">
          <div className="midnight-horizon-inner">
            <div className="midnight-section-head">
              <span className="midnight-eyebrow">ENTERPRISE FLEET &amp; RECOVERY PLATFORM</span>
              <h2>
                Roadside Recovery &amp; <span>Fleet Command</span> Engine
              </h2>
              <p>
                Engineered for high-volume national dispatch across 120,000+ service operations with
                live GPS fleet telemetry, automated insurer eligibility verification, and instant
                road-network routing.
              </p>
            </div>

            {/* 4 Live Operational Metrics */}
            <div className="midnight-stats-grid">
              <div className="midnight-stat-card">
                <div className="midnight-stat-val">120,000+</div>
                <div className="midnight-stat-title">Completed Recoveries</div>
                <p>Full national dispatch history with tamper-proof compliance auditing.</p>
              </div>
              <div className="midnight-stat-card">
                <div className="midnight-stat-val">Live CAD</div>
                <div className="midnight-stat-title">GPS Telemetry &amp; Routing</div>
                <p>Interactive Lebanon map, live traffic overlay, and multi-stop truck queues.</p>
              </div>
              <div className="midnight-stat-card">
                <div className="midnight-stat-val">Multi-Tier</div>
                <div className="midnight-stat-title">Quota &amp; Cooldown Engine</div>
                <p>Sequential policy tier tracking, distance allowances, and interval checks.</p>
              </div>
              <div className="midnight-stat-card">
                <div className="midnight-stat-val">Real-Time</div>
                <div className="midnight-stat-title">Multi-Desk Synchronization</div>
                <p>Instant quota locking and revision protection across all dispatch stations.</p>
              </div>
            </div>

            {/* 3 Platform Pillars */}
            <div className="midnight-pillars-grid">
              <article className="midnight-pillar-card">
                <div className="midnight-pillar-num">01</div>
                <h3>24/7 Roadside &amp; Accident Assist</h3>
                <p>
                  Instant caller CTI identification, precision GPS pin drop, OSRM road-distance
                  routing, and automated excess-kilometer overage calculation.
                </p>
              </article>

              <article className="midnight-pillar-card" id="fleetlogic">
                <div className="midnight-pillar-num">02</div>
                <h3>FleetLogic™ Live GPS CAD</h3>
                <p>
                  Real-time recovery unit telemetry, multi-stop priority sequence reordering
                  (1P → 1D → 2P → 2D), night-shift overtime payroll, and subcontractor outsourcing.
                </p>
              </article>

              <article className="midnight-pillar-card" id="insurers">
                <div className="midnight-pillar-num">03</div>
                <h3>Multi-Policy Insurer Quota Engine</h3>
                <p>
                  1:N customer-to-policy management across Allianz, Bankers, AXA, Medgulf,
                  Fidelity, and LIA with sequential quota tier &amp; cooldown enforcement.
                </p>
              </article>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Modern Obsidian Command Top Navbar */}
      <header className="o-main-navbar">
        <div className="o-navbar-left">
          <div className="o-app-brand">
            <span className="tracker-mini-emblem" aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3a9 9 0 1 0 9 9"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                />
                <circle cx="18.5" cy="5.5" r="2.5" fill="currentColor" />
              </svg>
            </span>
            <span className="o-brand-wordmark">
              TRACKER <em>Connect™</em>
            </span>
            <span className="o-app-brand-badge">CAD OS</span>
          </div>

          <nav className="o-menu-sections">
            <button
              className={activeTab === 'map' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setOpsBillingDropdownOpen(false);
                setConfigDropdownOpen(false);
                setActiveTab('map');
              }}
            >
              Live Fleet Map
            </button>
            <button
              className={activeTab === 'queue' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setOpsBillingDropdownOpen(false);
                setConfigDropdownOpen(false);
                setActiveTab('queue');
              }}
            >
              Dispatch Board
            </button>
            <button
              className={activeTab === 'intake' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setOpsBillingDropdownOpen(false);
                setConfigDropdownOpen(false);
                setActiveTab('intake');
              }}
            >
              Call Desk
            </button>

            {/* Customers & Policies Dropdown */}
            <div className="o-nav-dropdown-wrap">
              <button
                className={
                  activeTab === 'customers' || activeTab === 'policies'
                    ? 'o-nav-link active'
                    : 'o-nav-link'
                }
                onClick={() => {
                  setOpsBillingDropdownOpen(false);
                  setConfigDropdownOpen(false);
                  setCustPolDropdownOpen(prev => !prev);
                }}
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
                    <span>Customers Directory</span>
                    <span className="dropdown-count-pill">{customersList.length}</span>
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
                    <span>Insurance Policies</span>
                    <span className="dropdown-count-pill">{dashboard?.policies?.length || 0}</span>
                  </button>
                </div>
              )}
            </div>

            {/* Billing & Tariffs Dropdown */}
            <div className="o-nav-dropdown-wrap">
              <button
                className={
                  activeTab === 'tariffs' || activeTab === 'billing'
                    ? 'o-nav-link active'
                    : 'o-nav-link'
                }
                onClick={() => {
                  setCustPolDropdownOpen(false);
                  setConfigDropdownOpen(false);
                  setOpsBillingDropdownOpen(prev => !prev);
                }}
              >
                Billing &amp; Tariffs ▾
              </button>
              {opsBillingDropdownOpen && (
                <div className="o-nav-dropdown-menu">
                  <button
                    type="button"
                    className={activeTab === 'billing' ? 'o-dropdown-item active' : 'o-dropdown-item'}
                    onClick={() => {
                      setActiveTab('billing');
                      setInvoiceViewMode('list');
                      setOpsBillingDropdownOpen(false);
                    }}
                  >
                    <span>Invoices &amp; Payments</span>
                    <span className="dropdown-count-pill">{dashboard?.invoices?.length || 0}</span>
                  </button>
                  <button
                    type="button"
                    className={activeTab === 'tariffs' ? 'o-dropdown-item active' : 'o-dropdown-item'}
                    onClick={() => {
                      setActiveTab('tariffs');
                      setTariffViewMode('list');
                      setOpsBillingDropdownOpen(false);
                    }}
                  >
                    <span>Tariffs &amp; Pricing</span>
                    <span className="dropdown-count-pill">{dashboard?.tariffs?.length || 0}</span>
                  </button>
                </div>
              )}
            </div>

            <button
              className={activeTab === 'concurrency' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setOpsBillingDropdownOpen(false);
                setConfigDropdownOpen(false);
                setActiveTab('concurrency');
              }}
            >
              System Integrity
            </button>
            <button
              className={activeTab === 'performance' ? 'o-nav-link active' : 'o-nav-link'}
              onClick={() => {
                setCustPolDropdownOpen(false);
                setOpsBillingDropdownOpen(false);
                setConfigDropdownOpen(false);
                setActiveTab('performance');
              }}
            >
              Dispatch Archive
            </button>

            {/* Configuration Hub Dropdown: Users, User Groups, Tow Trucks & Drivers */}
            {(currentUser.canManageUsers ||
              currentUser.canManageFleet ||
              currentUser.accessRole === 'ADMIN' ||
              currentUser.accessRole === 'Admin' ||
              currentUser.username === 'assaad.khalife') && (
              <div className="o-nav-dropdown-wrap">
                <button
                  className={
                    activeTab === 'users' ||
                    activeTab === 'groups' ||
                    activeTab === 'trucks' ||
                    activeTab === 'drivers'
                      ? 'o-nav-link active'
                      : 'o-nav-link'
                  }
                  onClick={() => {
                    setCustPolDropdownOpen(false);
                    setOpsBillingDropdownOpen(false);
                    setConfigDropdownOpen(prev => !prev);
                  }}
                >
                  Configuration ▾
                </button>
                {configDropdownOpen && (
                  <div className="o-nav-dropdown-menu">
                    {(currentUser.canManageUsers ||
                      currentUser.accessRole === 'ADMIN' ||
                      currentUser.accessRole === 'Admin' ||
                      currentUser.username === 'assaad.khalife') && (
                      <>
                        <button
                          type="button"
                          className={activeTab === 'users' ? 'o-dropdown-item active' : 'o-dropdown-item'}
                          onClick={() => {
                            setConfigSearch('');
                            setUserViewMode('list');
                            setActiveTab('users');
                            setConfigDropdownOpen(false);
                          }}
                        >
                          <span>Users</span>
                          <span className="dropdown-count-pill">{adminUsers.length || 4}</span>
                        </button>
                        <button
                          type="button"
                          className={activeTab === 'groups' ? 'o-dropdown-item active' : 'o-dropdown-item'}
                          onClick={() => {
                            setConfigSearch('');
                            setGroupViewMode('list');
                            setActiveTab('groups');
                            setConfigDropdownOpen(false);
                          }}
                        >
                          <span>User Groups &amp; Permissions</span>
                          <span className="dropdown-count-pill">{userGroups.length || 4}</span>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={activeTab === 'trucks' ? 'o-dropdown-item active' : 'o-dropdown-item'}
                      onClick={() => {
                        setConfigSearch('');
                        setTruckViewMode('list');
                        setActiveTab('trucks');
                        setConfigDropdownOpen(false);
                      }}
                    >
                      <span>Tow Trucks</span>
                      <span className="dropdown-count-pill">{dashboard?.trucks?.length || 0}</span>
                    </button>
                    <button
                      type="button"
                      className={activeTab === 'drivers' ? 'o-dropdown-item active' : 'o-dropdown-item'}
                      onClick={() => {
                        setConfigSearch('');
                        setDriverViewMode('list');
                        setActiveTab('drivers');
                        setConfigDropdownOpen(false);
                      }}
                    >
                      <span>Drivers</span>
                      <span className="dropdown-count-pill">{dashboard?.drivers?.length || 0}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </nav>
        </div>

        <div className="o-navbar-systray">
          <button className="btn-incoming-call" onClick={triggerIncomingCall}>
            <span className="cti-live-dot" aria-hidden="true"></span>
            Incoming CTI Line
          </button>
          <div className="o-systray-pill" title={`SESSION_CONTEXT AppUsername: ${currentUser.username}`}>
            <span>{currentUser.fullName}</span>
            <strong>{currentUser.groupName || currentUser.accessRole || currentUser.stationCode}</strong>
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
                {activeTab === 'users' && 'Configuration / Users'}
                {activeTab === 'groups' && 'Configuration / User Groups & Permissions'}
                {activeTab === 'trucks' && 'Configuration / Tow Trucks'}
                {activeTab === 'drivers' && 'Configuration / Drivers'}
                {activeTab === 'tariffs' && 'Billing & Tariffs / Tariffs Schedule'}
                {activeTab === 'billing' && 'Billing & Tariffs / Invoices & Payments'}
                {activeTab === 'queue' && 'Dispatch Lifecycle Board'}
                {activeTab === 'concurrency' && 'Transaction Integrity & Audit Trail'}
                {activeTab === 'performance' && 'National Dispatch Archive'}
              </span>
            </div>

            {/* Configuration Sub-Menu Switcher: Users | User Groups | Tow Trucks | Drivers */}
            {(activeTab === 'users' ||
              activeTab === 'groups' ||
              activeTab === 'trucks' ||
              activeTab === 'drivers') && (
              <div className="action-btn-group">
                <div className="config-subnav-pills">
                  {(currentUser.canManageUsers ||
                    currentUser.accessRole === 'ADMIN' ||
                    currentUser.accessRole === 'Admin' ||
                    currentUser.username === 'assaad.khalife') && (
                    <>
                      <button
                        type="button"
                        className={activeTab === 'users' ? 'config-subnav-pill active' : 'config-subnav-pill'}
                        onClick={() => {
                          setConfigSearch('');
                          setUserViewMode('list');
                          setActiveTab('users');
                        }}
                      >
                        Users
                      </button>
                      <button
                        type="button"
                        className={activeTab === 'groups' ? 'config-subnav-pill active' : 'config-subnav-pill'}
                        onClick={() => {
                          setConfigSearch('');
                          setGroupViewMode('list');
                          setActiveTab('groups');
                        }}
                      >
                        User Groups
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={activeTab === 'trucks' ? 'config-subnav-pill active' : 'config-subnav-pill'}
                    onClick={() => {
                      setConfigSearch('');
                      setTruckViewMode('list');
                      setActiveTab('trucks');
                    }}
                  >
                    Tow Trucks
                  </button>
                  <button
                    type="button"
                    className={activeTab === 'drivers' ? 'config-subnav-pill active' : 'config-subnav-pill'}
                    onClick={() => {
                      setConfigSearch('');
                      setDriverViewMode('list');
                      setActiveTab('drivers');
                    }}
                  >
                    Drivers
                  </button>
                </div>

                {activeTab === 'users' && (
                  <button
                    type="button"
                    className="btn-erp-primary"
                    onClick={() => setUserViewMode('new')}
                  >
                    + New User
                  </button>
                )}
                {activeTab === 'groups' && (
                  <button
                    type="button"
                    className="btn-erp-primary"
                    onClick={() => setGroupViewMode('new')}
                  >
                    + New User Group
                  </button>
                )}
                {activeTab === 'trucks' && (
                  <button
                    type="button"
                    className="btn-erp-primary"
                    onClick={() => setTruckViewMode('new')}
                  >
                    + New Tow Truck
                  </button>
                )}
                {activeTab === 'drivers' && (
                  <button
                    type="button"
                    className="btn-erp-primary"
                    onClick={() => setDriverViewMode('new')}
                  >
                    + New Driver
                  </button>
                )}
              </div>
            )}

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

            {/* Sub-Menu Switcher for Billing & Tariffs */}
            {(activeTab === 'tariffs' || activeTab === 'billing') && (
              <div className="action-btn-group">
                <button
                  type="button"
                  className={activeTab === 'billing' ? 'btn-erp-primary' : 'btn-erp-secondary'}
                  onClick={() => {
                    setActiveTab('billing');
                    setInvoiceViewMode('list');
                  }}
                >
                  Invoices &amp; Payments
                </button>
                <button
                  type="button"
                  className={activeTab === 'tariffs' ? 'btn-erp-primary' : 'btn-erp-secondary'}
                  onClick={() => {
                    setActiveTab('tariffs');
                    setTariffViewMode('list');
                  }}
                >
                  Tariffs
                </button>
                {activeTab === 'tariffs' && (
                  <button
                    type="button"
                    className="btn-erp-primary"
                    onClick={() => setTariffViewMode('new')}
                  >
                    + New Tariff
                  </button>
                )}
              </div>
            )}

            {activeTab !== 'intake' &&
              activeTab !== 'customers' &&
              activeTab !== 'policies' &&
              activeTab !== 'users' &&
              activeTab !== 'groups' &&
              activeTab !== 'trucks' &&
              activeTab !== 'drivers' &&
              activeTab !== 'tariffs' &&
              activeTab !== 'billing' && (
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
            ) : activeTab === 'users' ||
              activeTab === 'groups' ||
              activeTab === 'trucks' ||
              activeTab === 'drivers' ? (
              <input
                type="text"
                className="o-cp-search-input"
                placeholder={`Search ${activeTab} list...`}
                value={configSearch}
                onChange={e => {
                  setConfigSearch(e.target.value);
                  if (activeTab === 'users' && userViewMode !== 'list') setUserViewMode('list');
                  if (activeTab === 'groups' && groupViewMode !== 'list') setGroupViewMode('list');
                  if (activeTab === 'trucks' && truckViewMode !== 'list') setTruckViewMode('list');
                  if (activeTab === 'drivers' && driverViewMode !== 'list') setDriverViewMode('list');
                }}
              />
            ) : activeTab === 'billing' ? (
              <input
                type="text"
                className="o-cp-search-input"
                placeholder="Search invoice #, request #, customer, or insurer..."
                value={billingSearch}
                onChange={e => {
                  setBillingSearch(e.target.value);
                  if (invoiceViewMode !== 'list') setInvoiceViewMode('list');
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
                  Insurer Due:
                  <strong>${Number(kpis.unpaidInsurerBalance || 0).toLocaleString()}</strong>
                </div>
                <div className="o-kpi-chip">
                  Customer Due:
                  <strong>${Number(kpis.unpaidCustomerBalance || 0).toLocaleString()}</strong>
                </div>
              </div>
            )}

            {Boolean(CHANGE_LOG_SECTIONS[activeTab]) && (
              <button
                type="button"
                className={changeLogOpen ? 'btn-erp-primary' : 'btn-erp-secondary'}
                style={{ marginLeft: '8px' }}
                onClick={() => setChangeLogOpen(prev => !prev)}
                title={`View ${CHANGE_LOG_SECTIONS[activeTab]} section change log`}
              >
                {changeLogOpen ? 'Close Change Log' : 'Change Log'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className={`toast toast-${toast.type}`} role="status" aria-live="polite">
          <div>
            <strong>{toast.title}</strong>
            <p>{toast.message}</p>
          </div>
          <button aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button>
        </div>
      )}

      {/* Incoming Phone Call Modal (Only passes Caller Phone Number) */}
      {incomingCallModal && (
        <div className="modal-backdrop">
          <div className="modal-box incoming-call-modal" role="dialog" aria-modal="true" aria-labelledby="incoming-call-title">
            <div className="incoming-call-ring-badge">INCOMING EMERGENCY CALL</div>
            <h3 id="incoming-call-title">Incoming Caller Number</h3>
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
          <div className="modal-box warning-modal" role="alertdialog" aria-modal="true" aria-labelledby="policy-warning-title">
            <h3 id="policy-warning-title">{policyWarningModal.title}</h3>
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

      {/* Record Partial or Full Invoice Payment Modal (dbo.InvoicePayments) */}
      {paymentModalInvoice && (
        <div className="modal-backdrop">
          <div className="modal-box" role="dialog" aria-modal="true" aria-labelledby="payment-modal-title">
            <div className="modal-header-row">
              <h3 id="payment-modal-title">
                Record Payment Row • {paymentModalInvoice.invoiceNumber}
              </h3>
              <button
                type="button"
                className="btn-close"
                aria-label="Close payment modal"
                onClick={() => setPaymentModalInvoice(null)}
              >
                ✕
              </button>
            </div>
            <p className="muted" style={{ marginBottom: '12px' }}>
              Each partial or full payment inserts a separate immutable row in{' '}
              <code>dbo.InvoicePayments</code> linked to the payer (Insurer vs Customer).
            </p>
            <div className="elig-metrics" style={{ marginBottom: '12px' }}>
              <div className="metric-item">
                <span>Insurer Balance Due</span>
                <strong>${paymentModalInvoice.insurerBalanceDue}</strong>
              </div>
              <div className="metric-item">
                <span>Customer Balance Due</span>
                <strong>${paymentModalInvoice.customerBalanceDue}</strong>
              </div>
              <div className="metric-item">
                <span>Current Status</span>
                <strong>{paymentModalInvoice.invoiceStatus}</strong>
              </div>
            </div>

            <form onSubmit={handleRecordInvoicePayment}>
              <div className="form-row">
                <label>Payer Obligation Type</label>
                <select
                  value={paymentForm.payerType}
                  onChange={e => {
                    const pType = e.target.value;
                    const suggestedAmt =
                      pType === 'InsuranceProvider'
                        ? Number(paymentModalInvoice.insurerBalanceDue || 0)
                        : Number(paymentModalInvoice.customerBalanceDue || 0);
                    setPaymentForm(prev => ({
                      ...prev,
                      payerType: pType,
                      paymentMethod: pType === 'InsuranceProvider' ? 'BankTransfer' : 'OnSceneCash',
                      amountPaid: suggestedAmt > 0 ? suggestedAmt : prev.amountPaid
                    }));
                  }}
                >
                  <option
                    value="InsuranceProvider"
                    disabled={Number(paymentModalInvoice.insurerBalanceDue) <= 0}
                  >
                    InsuranceProvider ({paymentModalInvoice.insuranceProviderName || 'No Insurer'}) — Due ${paymentModalInvoice.insurerBalanceDue}
                  </option>
                  <option
                    value="Customer"
                    disabled={Number(paymentModalInvoice.customerBalanceDue) <= 0}
                  >
                    Customer ({paymentModalInvoice.customerName}) — Due ${paymentModalInvoice.customerBalanceDue}
                  </option>
                </select>
              </div>

              <div className="form-row" style={{ marginTop: '8px' }}>
                <label>Amount to Pay ($) — Partial or Full</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={paymentForm.amountPaid}
                  onChange={e => setPaymentForm({ ...paymentForm, amountPaid: e.target.value })}
                  required
                />
              </div>

              <div className="form-row" style={{ marginTop: '8px' }}>
                <label>Payment Method</label>
                <select
                  value={paymentForm.paymentMethod}
                  onChange={e => setPaymentForm({ ...paymentForm, paymentMethod: e.target.value })}
                >
                  <option value="BankTransfer">BankTransfer</option>
                  <option value="InsurerBatchSettlement">InsurerBatchSettlement</option>
                  <option value="OnSceneCash">OnSceneCash</option>
                  <option value="Card">Card</option>
                  <option value="Cheque">Cheque</option>
                </select>
              </div>

              <div className="form-row" style={{ marginTop: '8px' }}>
                <label>Bank / Receipt Reference #</label>
                <input
                  type="text"
                  value={paymentForm.referenceNumber}
                  onChange={e => setPaymentForm({ ...paymentForm, referenceNumber: e.target.value })}
                />
              </div>

              {paymentForm.payerType === 'Customer' && (
                <div className="form-row" style={{ marginTop: '8px' }}>
                  <label>Collected On-Scene By Driver (Optional)</label>
                  <select
                    value={paymentForm.collectedByDriverId}
                    onChange={e =>
                      setPaymentForm({ ...paymentForm, collectedByDriverId: e.target.value })
                    }
                  >
                    <option value="">Front Desk / Electronic Settlement</option>
                    {dashboard?.drivers?.map(d => (
                      <option key={d.driverId} value={d.driverId}>
                        {d.fullName} ({d.employeeCode})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="form-row" style={{ marginTop: '8px' }}>
                <label>Settlement Notes</label>
                <input
                  type="text"
                  value={paymentForm.notes}
                  onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                />
              </div>

              <div className="modal-actions" style={{ marginTop: '14px' }}>
                <button type="submit" className="btn-primary">
                  Insert Payment Row
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setPaymentModalInvoice(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Built-in Google Maps Location Picker Modal (Beirut default, Google-style search bar, draggable pin) */}
      {locationPicker.open && (
        <div className="modal-backdrop">
          <div className="modal-box location-picker-modal" role="dialog" aria-modal="true" aria-labelledby="location-picker-title">
            <div className="modal-header-row">
              <h3 id="location-picker-title">
                {locationPicker.target === 'pickup'
                  ? 'Pick Breakdown / Pickup Location'
                  : 'Pick Destination / Dropoff Location'}
              </h3>
              <button
                className="btn-close"
                aria-label="Close location picker"
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
                placeholder="Search place, street, or landmark in Lebanon (e.g. Jbeil, Hamra, Jounieh)..."
                value={locationPicker.searchQuery}
                onChange={e => handleLocationSearch(e.target.value)}
              />
              {locationPicker.searchResults.length > 0 && (
                <div className="map-search-dropdown">
                  {locationPicker.searchResults.map((item, idx) => (
                    <button
                      type="button"
                      key={idx}
                      className="map-search-item"
                      onClick={() => selectAutocompleteLocation(item)}
                    >
                      <span>{item.name}</span>
                      <small>
                        {item.lat}, {item.lng}
                      </small>
                    </button>
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
          <div className="modal-box" role="dialog" aria-modal="true" aria-labelledby="plate-modal-title">
            <h3 id="plate-modal-title">Register Regional Plate Prefix</h3>
            <p className="muted">
              Register a new regional or category license plate prefix (e.g. <code>Y</code>,{' '}
              <code>R</code>, <code>C</code>) for vehicle intake.
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
                    aria-label="Close fleet drawer"
                  >
                    ✕
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
                  onClick={e => handleCreateTowRequest(e, false, 'Draft')}
                >
                  Save Draft Ticket
                </button>
                <button
                  type="button"
                  className="btn-erp-secondary"
                  onClick={e => handleCreateTowRequest(e, false, 'PendingInsurance')}
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
                    <label>Registered Vehicle</label>
                    <div className="erp-field-val">
                      <select
                        value={selectedVehicleId}
                        onChange={e => {
                          const vid = e.target.value;
                          setSelectedVehicleId(vid);
                          if (!vid) {
                            setIntakeForm(prev => ({
                              ...prev,
                              noPlate: false,
                              plateCodeId: 2,
                              plateDigits: '',
                              vehicleDesc: ''
                            }));
                            return;
                          }
                          const veh = customerVehicles.find(v => v.vehicleId === Number(vid));
                          if (veh) {
                            setIntakeForm(prev => ({
                              ...prev,
                              noPlate: Boolean(veh.noPlate),
                              plateCodeId: veh.plateCodeId || 2,
                              plateDigits: veh.plateDigits || '',
                              vehicleDesc: veh.vehicleModel || ''
                            }));
                          }
                        }}
                      >
                        <option value="">+ New / Unlisted Vehicle (Auto-Register in dbo.Vehicles)</option>
                        {customerVehicles.map(v => (
                          <option key={v.vehicleId} value={v.vehicleId}>
                            {v.vehiclePlate} — {v.vehicleModel}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>License Plate</label>
                    <div className="erp-field-val">
                      <div className="erp-plate-flex">
                        {!intakeForm.noPlate && (
                          <>
                            <select
                              value={intakeForm.plateCodeId}
                              onChange={e => {
                                setSelectedVehicleId('');
                                setIntakeForm({ ...intakeForm, plateCodeId: e.target.value });
                              }}
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
                              onChange={e => {
                                setSelectedVehicleId('');
                                setIntakeForm({ ...intakeForm, plateDigits: e.target.value });
                              }}
                              required={!intakeForm.noPlate}
                            />
                          </>
                        )}
                        <label className="erp-toggle-switch" style={{ whiteSpace: 'nowrap' }}>
                          <input
                            type="checkbox"
                            checked={intakeForm.noPlate}
                            onChange={e => {
                              setSelectedVehicleId('');
                              setIntakeForm({ ...intakeForm, noPlate: e.target.checked });
                            }}
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
                        <option value="Tire">Flat Tire</option>
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

              {/* GROUP ROW 3: Validated Road Distance vs Geodesic | Active Tariff & Split Billing */}
              <div className="erp-group-grid">
                <div className="erp-group-col">
                  <div className="erp-group-header">ROAD-DISTANCE ROUTING &amp; PROVENANCE</div>

                  <div className="erp-field-row">
                    <label>Straight-Line Geodesic</label>
                    <div className="erp-field-val">
                      <span className="muted">
                        {eligibility?.straightLineDistanceKm ?? 0} KM (Haversine air distance — NOT billed)
                      </span>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Routed Road Distance</label>
                    <div className="erp-field-val">
                      <strong>{eligibility?.calculatedRoadKm ?? 0} KM</strong>{' '}
                      <span className="badge badge-Approved" style={{ marginLeft: '6px' }}>
                        {eligibility?.distanceSource || 'OSRM_DrivingRoute'}
                      </span>
                      {eligibility?.routeDurationMinutes ? (
                        <span className="muted" style={{ marginLeft: '6px' }}>
                          (~{eligibility.routeDurationMinutes} min)
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Verified Road Override (KM)</label>
                    <div className="erp-field-val">
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="Optional: Leave blank for OSRM route, or enter verified road KM"
                        value={intakeForm.verifiedRoadDistanceKm}
                        onChange={e =>
                          setIntakeForm({
                            ...intakeForm,
                            verifiedRoadDistanceKm: e.target.value
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Allowed Policy Distance</label>
                    <div className="erp-field-val">
                      <span>
                        {intakeForm.hasInsurance
                          ? `${eligibility?.allowedDistanceKm ?? 0} KM (Covered: ${
                              eligibility?.coveredDistanceKm ?? 0
                            } KM)`
                          : '0 KM (Direct Customer Billing)'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="erp-group-col">
                  <div className="erp-group-header">TARIFF SNAPSHOT &amp; SPLIT OBLIGATIONS</div>

                  <div className="erp-field-row">
                    <label>Active Tariff (dbo.Tariffs)</label>
                    <div className="erp-field-val">
                      <span>
                        <strong>{eligibility?.tariffCode || '—'}</strong> (Base $
                        {eligibility?.appliedBaseFee ?? 0} • ${eligibility?.appliedPricePerKm ?? 0}/KM • Night +$
                        {eligibility?.appliedNightSurcharge ?? 0})
                      </span>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Insurer Obligation ($)</label>
                    <div className="erp-field-val">
                      <strong className="text-amber">
                        ${eligibility?.insurerBilledAmount ?? 0}
                      </strong>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Customer Obligation ($)</label>
                    <div className="erp-field-val">
                      <strong
                        className={
                          (eligibility?.customerBilledAmount ?? eligibility?.overageAmount ?? 0) > 0
                            ? 'text-red'
                            : 'text-green'
                        }
                        style={{ fontSize: '15px' }}
                      >
                        ${eligibility?.customerBilledAmount ?? eligibility?.overageAmount ?? 0}
                      </strong>{' '}
                      <span className="muted">
                        (Excess: {eligibility?.overageKm ?? 0} KM)
                      </span>
                    </div>
                  </div>

                  <div className="erp-field-row">
                    <label>Total Invoice Snapshot ($)</label>
                    <div className="erp-field-val">
                      <strong>${eligibility?.totalInvoiceAmount ?? 0}</strong>
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
                            )?.driverName || 'Auto-assigned via DriverTruckAssignments'}
                          </span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="erp-field-row">
                        <label>Subcontractor (dbo.Subcontractors)</label>
                        <div className="erp-field-val">
                          <select
                            value={intakeForm.subcontractorId}
                            onChange={e => {
                              const sid = Number(e.target.value);
                              const subObj = (dashboard?.subcontractors || []).find(
                                s => s.subcontractorId === sid
                              );
                              setIntakeForm({
                                ...intakeForm,
                                subcontractorId: sid,
                                subcontractorFee: subObj
                                  ? Number(subObj.defaultDispatchFee)
                                  : intakeForm.subcontractorFee
                              });
                            }}
                            required={intakeForm.isOutsourced}
                          >
                            {(dashboard?.subcontractors || []).map(s => (
                              <option key={s.subcontractorId} value={s.subcontractorId}>
                                {s.companyName} — {s.coverageRegion} (Default ${s.defaultDispatchFee})
                              </option>
                            ))}
                          </select>
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
                      onClick={() => {
                        setEditingCustomerForm(null);
                        setCustomerViewMode('list');
                      }}
                    >
                      ← Back to Customers List
                    </button>
                    {!editingCustomerForm ? (
                      <button
                        type="button"
                        className="btn-erp-secondary"
                        onClick={() =>
                          setEditingCustomerForm({
                            customerId: selectedCustomerObj.customerId,
                            fullName: selectedCustomerObj.fullName,
                            phone: selectedCustomerObj.phone,
                            email: selectedCustomerObj.email || ''
                          })
                        }
                      >
                        Edit Customer Record
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-erp-secondary"
                        onClick={() => setEditingCustomerForm(null)}
                      >
                        Cancel Edit
                      </button>
                    )}
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
                      + Attach New Policy
                    </button>
                  </div>
                  <div className="o-statusbar-status">
                    <span className="o-stage-pill current">Active 3NF Customer</span>
                  </div>
                </div>

                <div className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">dbo.Customers Record #{selectedCustomerObj.customerId}</span>
                    <h1>{selectedCustomerObj.fullName}</h1>
                  </div>

                  {editingCustomerForm ? (
                    <form onSubmit={handleSaveCustomerEdit} className="optimistic-box" style={{ marginBottom: '16px' }}>
                      <div className="erp-group-grid" style={{ marginBottom: 0 }}>
                        <div className="erp-group-col">
                          <div className="form-row">
                            <label>Full Name</label>
                            <input
                              type="text"
                              value={editingCustomerForm.fullName}
                              onChange={e =>
                                setEditingCustomerForm({ ...editingCustomerForm, fullName: e.target.value })
                              }
                              required
                            />
                          </div>
                          <div className="form-row" style={{ marginTop: '8px' }}>
                            <label>Phone Number (Unique)</label>
                            <input
                              type="text"
                              value={editingCustomerForm.phone}
                              onChange={e =>
                                setEditingCustomerForm({ ...editingCustomerForm, phone: e.target.value })
                              }
                              required
                            />
                          </div>
                        </div>
                        <div className="erp-group-col">
                          <div className="form-row">
                            <label>Email Address</label>
                            <input
                              type="email"
                              value={editingCustomerForm.email}
                              onChange={e =>
                                setEditingCustomerForm({ ...editingCustomerForm, email: e.target.value })
                              }
                            />
                          </div>
                          <div style={{ marginTop: '24px' }}>
                            <button type="submit" className="btn-primary">
                              Save Customer Changes
                            </button>
                          </div>
                        </div>
                      </div>
                    </form>
                  ) : (
                    <div className="erp-group-grid">
                      <div className="erp-group-col">
                        <div className="erp-group-header">CONTACT INFORMATION (dbo.Customers)</div>
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
                        <div className="erp-group-header">RELATED 3NF PORTFOLIO</div>
                        <div className="erp-field-row">
                          <label>Linked Policies</label>
                          <div className="erp-field-val">
                            <strong>{customerPolicies.length} Policies</strong>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Registered Vehicles</label>
                          <div className="erp-field-val">
                            <strong>
                              {(dashboard?.vehicles || []).filter(v => v.customerId === selectedCustomerObj.customerId).length} Vehicles
                            </strong>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="erp-notebook">
                    <div className="erp-notebook-tabs">
                      <button
                        type="button"
                        className={customerNotebookTab === 'policies' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                        onClick={() => setCustomerNotebookTab('policies')}
                      >
                        Insurance Policies ({customerPolicies.length})
                      </button>
                      <button
                        type="button"
                        className={customerNotebookTab === 'vehicles' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                        onClick={() => setCustomerNotebookTab('vehicles')}
                      >
                        Registered Vehicles (
                        {(dashboard?.vehicles || []).filter(v => v.customerId === selectedCustomerObj.customerId).length}
                        )
                      </button>
                      <button
                        type="button"
                        className={customerNotebookTab === 'tows' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                        onClick={() => setCustomerNotebookTab('tows')}
                      >
                        Tow Requests &amp; Invoices (
                        {(dashboard?.recentRequests || []).filter(r => r.customerId === selectedCustomerObj.customerId).length}
                        )
                      </button>
                    </div>
                    <div className="erp-notebook-page">
                      {customerNotebookTab === 'policies' && (
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
                              <tr
                                key={p.policyId}
                                className="clickable-row"
                                onClick={() => openPolicyRecord(p.policyId)}
                              >
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
                                <td onClick={e => e.stopPropagation()}>
                                  <button
                                    type="button"
                                    className="btn-xs"
                                    onClick={() => openPolicyRecord(p.policyId)}
                                  >
                                    Open Policy &amp; Quotas
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}

                      {customerNotebookTab === 'vehicles' && (
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Vehicle ID</th>
                              <th>License Plate</th>
                              <th>Vehicle Model</th>
                              <th>Plate Registration Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(dashboard?.vehicles || [])
                              .filter(v => v.customerId === selectedCustomerObj.customerId)
                              .map(v => (
                                <tr key={v.vehicleId}>
                                  <td>#{v.vehicleId}</td>
                                  <td>
                                    <code>{v.vehiclePlate}</code>
                                  </td>
                                  <td>
                                    <strong>{v.vehicleModel}</strong>
                                  </td>
                                  <td>
                                    {v.noPlate ? (
                                      <span className="badge badge-PendingInsurance">Unregistered Showroom (NoPlate=1)</span>
                                    ) : (
                                      <span className="badge badge-Done">Registered Plate</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      )}

                      {customerNotebookTab === 'tows' && (
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Request #</th>
                              <th>Vehicle</th>
                              <th>Issue Type</th>
                              <th>Road Distance</th>
                              <th>Status</th>
                              <th>Linked Invoice</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(dashboard?.recentRequests || [])
                              .filter(r => r.customerId === selectedCustomerObj.customerId)
                              .map(r => (
                                <tr
                                  key={r.towRequestId}
                                  className="clickable-row"
                                  onClick={() => openTowRequestRecord(r.towRequestId)}
                                >
                                  <td>
                                    <strong>{r.requestNumber}</strong>
                                  </td>
                                  <td>
                                    <code>{r.vehiclePlate}</code> — {r.vehicleModel}
                                  </td>
                                  <td>{r.issueType}</td>
                                  <td>{r.actualDistanceKm} km</td>
                                  <td>
                                    <span className={`badge badge-${r.status}`}>{r.status}</span>
                                  </td>
                                  <td onClick={e => e.stopPropagation()}>
                                    {r.invoiceId > 0 ? (
                                      <button
                                        type="button"
                                        className="rel-entity-link"
                                        onClick={() => openInvoiceRecord(r.invoiceId)}
                                      >
                                        Invoice #{r.invoiceId} ({r.invoiceStatus})
                                      </button>
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                    {renderInlineRecordChatter(selectedCustomerObj.fullName)}
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
                    {renderInlineRecordChatter(selectedPolicyObj.policyNumber)}
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
                            {(dashboard?.providers || []).map(prov => (
                              <option key={prov.providerId} value={prov.providerId}>
                                {prov.providerName} ({prov.supportPhone})
                              </option>
                            ))}
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

        {/* ==========================================================================
            CONFIGURATION SECTION 2: TOW TRUCKS (List -> Truck Sheet + Related Info)
           ========================================================================== */}
        {activeTab === 'trucks' && (
          <div className="o-form-sheet">
            {truckViewMode === 'list' && (
              <div className="erp-sheet-pad">
                <div className="card-header-flex" style={{ marginBottom: '12px' }}>
                  <div>
                    <h3>Tow Trucks Fleet Directory (dbo.TowTrucks)</h3>
                    <p className="muted">
                      Pure normalized fleet hardware &amp; GPS units. Click any tow truck row to
                      inspect or edit its specs, rotate its active driver, and view its historical{' '}
                      <code>DriverTruckAssignments</code> &amp; <code>TowRequests</code>.
                    </p>
                  </div>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Truck Code</th>
                      <th>License Plate</th>
                      <th>Model &amp; Capacity</th>
                      <th>Active Driver (DriverTruckAssignments)</th>
                      <th>Fleet Status</th>
                      <th>GPS Telemetry</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.trucks || [])
                      .filter(t => {
                        const q = configSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          t.truckCode.toLowerCase().includes(q) ||
                          t.licensePlate.toLowerCase().includes(q) ||
                          t.truckModel.toLowerCase().includes(q) ||
                          (t.driverName || '').toLowerCase().includes(q)
                        );
                      })
                      .map(t => (
                        <tr
                          key={t.truckId}
                          className="clickable-row"
                          onClick={() => openTruckRecord(t.truckId)}
                        >
                          <td>
                            <strong>{t.truckCode}</strong>
                          </td>
                          <td>
                            <code>{t.licensePlate}</code>
                          </td>
                          <td>
                            <strong>{t.truckModel}</strong>
                            <br />
                            <small className="muted">Max Payload: {t.maxPayloadKg} kg</small>
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            {t.driverId ? (
                              <button
                                type="button"
                                className="rel-entity-link"
                                onClick={() => openDriverRecord(t.driverId)}
                              >
                                {t.driverName} ({t.driverPhone})
                              </button>
                            ) : (
                              <span className="muted">Unassigned / Standby</span>
                            )}
                          </td>
                          <td>
                            <span
                              className={`badge ${
                                t.fleetStatus === 'Available'
                                  ? 'badge-Done'
                                  : t.fleetStatus === 'Maintenance' || t.fleetStatus === 'OffDuty'
                                  ? 'badge-Rejected'
                                  : 'badge-Approved'
                              }`}
                            >
                              {t.fleetStatus}
                            </span>
                          </td>
                          <td>
                            <small className="muted">
                              {Number(t.currentLat).toFixed(4)}, {Number(t.currentLng).toFixed(4)}
                            </small>
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn-xs"
                              onClick={() => openTruckRecord(t.truckId)}
                            >
                              Open Truck Sheet
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {truckViewMode === 'form' && selectedTruckForm && (() => {
              const liveTruck =
                (dashboard?.trucks || []).find(t => t.truckId === selectedTruckForm.truckId) ||
                selectedTruckForm;
              const truckAssignments = (dashboard?.driverAssignments || []).filter(
                a => a.truckId === selectedTruckForm.truckId
              );
              const activeAssign = truckAssignments.find(a => !a.endDate);
              const truckRequests = (dashboard?.recentRequests || []).filter(
                r => r.assignedTruckId === selectedTruckForm.truckId
              );
              return (
                <>
                  <div className="o-form-statusbar">
                    <div className="action-btn-group">
                      <button
                        type="button"
                        className="btn-erp-secondary"
                        onClick={() => setTruckViewMode('list')}
                      >
                        ← Back to Tow Trucks List
                      </button>
                    </div>
                    <div className="o-statusbar-status">
                      <span className="o-stage-pill current">{liveTruck.fleetStatus}</span>
                    </div>
                  </div>

                  <div className="erp-sheet-pad">
                    <div className="erp-oe-title">
                      <span className="erp-oe-label">dbo.TowTrucks Record #{selectedTruckForm.truckId}</span>
                      <h1>
                        {selectedTruckForm.truckCode} — {selectedTruckForm.truckModel}
                      </h1>
                    </div>

                    <div className="erp-group-grid">
                      <form onSubmit={handleSaveTruck} className="erp-group-col">
                        <div className="erp-group-header">TOW TRUCK HARDWARE &amp; TELEMETRY</div>
                        <div className="form-row">
                          <label>Truck Code &amp; License Plate</label>
                          <div className="split-inputs">
                            <input
                              type="text"
                              value={selectedTruckForm.truckCode}
                              onChange={e =>
                                setSelectedTruckForm({
                                  ...selectedTruckForm,
                                  truckCode: e.target.value
                                })
                              }
                              required
                            />
                            <input
                              type="text"
                              value={selectedTruckForm.licensePlate}
                              onChange={e =>
                                setSelectedTruckForm({
                                  ...selectedTruckForm,
                                  licensePlate: e.target.value
                                })
                              }
                              required
                            />
                          </div>
                        </div>

                        <div className="form-row" style={{ marginTop: '8px' }}>
                          <label>Truck Model &amp; Max Payload (KG)</label>
                          <div className="split-inputs">
                            <input
                              type="text"
                              value={selectedTruckForm.truckModel}
                              onChange={e =>
                                setSelectedTruckForm({
                                  ...selectedTruckForm,
                                  truckModel: e.target.value
                                })
                              }
                              required
                            />
                            <input
                              type="number"
                              min="1000"
                              max="30000"
                              value={selectedTruckForm.maxPayloadKg}
                              onChange={e =>
                                setSelectedTruckForm({
                                  ...selectedTruckForm,
                                  maxPayloadKg: e.target.value
                                })
                              }
                              required
                            />
                          </div>
                        </div>

                        <div className="form-row" style={{ marginTop: '8px' }}>
                          <label>Fleet Status &amp; GPS Coordinates (Lat / Lng)</label>
                          <div className="split-inputs">
                            <select
                              value={selectedTruckForm.fleetStatus}
                              onChange={e =>
                                setSelectedTruckForm({
                                  ...selectedTruckForm,
                                  fleetStatus: e.target.value
                                })
                              }
                            >
                              <option value="Available">Available</option>
                              <option value="EnRoute">EnRoute</option>
                              <option value="Towing">Towing</option>
                              <option value="Maintenance">Maintenance</option>
                              <option value="OffDuty">OffDuty</option>
                            </select>
                            <input
                              type="number"
                              step="0.0001"
                              value={selectedTruckForm.currentLat}
                              onChange={e =>
                                setSelectedTruckForm({
                                  ...selectedTruckForm,
                                  currentLat: e.target.value
                                })
                              }
                              required
                            />
                            <input
                              type="number"
                              step="0.0001"
                              value={selectedTruckForm.currentLng}
                              onChange={e =>
                                setSelectedTruckForm({
                                  ...selectedTruckForm,
                                  currentLng: e.target.value
                                })
                              }
                              required
                            />
                          </div>
                        </div>

                        <div style={{ marginTop: '12px' }}>
                          <button type="submit" className="btn-primary">
                            Save Tow Truck Specifications
                          </button>
                        </div>
                      </form>

                      <div className="erp-group-col">
                        <div className="erp-group-header">RELATED FLEET OVERVIEW</div>
                        <div className="erp-field-row">
                          <label>Currently Assigned Driver</label>
                          <div className="erp-field-val">
                            {liveTruck.driverId ? (
                              <button
                                type="button"
                                className="rel-entity-link"
                                onClick={() => openDriverRecord(liveTruck.driverId)}
                              >
                                {liveTruck.driverName} ({liveTruck.driverPhone})
                              </button>
                            ) : (
                              <span className="muted">Unassigned / Standby</span>
                            )}
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Historical Driver Shifts</label>
                          <div className="erp-field-val">
                            <strong>{truckAssignments.length} Shift Records</strong>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Assigned Tow Requests</label>
                          <div className="erp-field-val">
                            <strong>{truckRequests.length} Rescues</strong>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Last GPS Telemetry</label>
                          <div className="erp-field-val">
                            <span className="muted">{liveTruck.lastTelemetryAt || 'Live'}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="erp-notebook">
                      <div className="erp-notebook-tabs">
                        <button
                          type="button"
                          className={truckNotebookTab === 'assignments' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                          onClick={() => setTruckNotebookTab('assignments')}
                        >
                          Driver Assignment Lineage ({truckAssignments.length})
                        </button>
                        <button
                          type="button"
                          className={truckNotebookTab === 'tows' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                          onClick={() => setTruckNotebookTab('tows')}
                        >
                          Assigned Tow Requests ({truckRequests.length})
                        </button>
                      </div>
                      <div className="erp-notebook-page">
                        {truckNotebookTab === 'assignments' && (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Assignment #</th>
                                <th>Driver</th>
                                <th>Start Date</th>
                                <th>End Date</th>
                                <th>Notes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {truckAssignments.map(a => (
                                <tr
                                  key={a.assignmentId}
                                  className="clickable-row"
                                  onClick={() => openDriverRecord(a.driverId)}
                                >
                                  <td>#{a.assignmentId}</td>
                                  <td>
                                    <span className="rel-entity-link">
                                      {a.driverName} ({a.employeeCode})
                                    </span>
                                  </td>
                                  <td>{a.startDate}</td>
                                  <td>
                                    {a.endDate ? (
                                      <span className="muted">{a.endDate}</span>
                                    ) : (
                                      <span className="badge badge-Done">Active Shift (NULL EndDate)</span>
                                    )}
                                  </td>
                                  <td>{a.assignmentNotes || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {truckNotebookTab === 'tows' && (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Request #</th>
                                <th>Customer &amp; Vehicle</th>
                                <th>Driver on Job</th>
                                <th>Pickup → Dropoff</th>
                                <th>Distance</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {truckRequests.map(r => (
                                <tr
                                  key={r.towRequestId}
                                  className="clickable-row"
                                  onClick={() => openTowRequestRecord(r.towRequestId)}
                                >
                                  <td>
                                    <strong>{r.requestNumber}</strong>
                                  </td>
                                  <td>
                                    {r.customerName} • <code>{r.vehiclePlate}</code>
                                  </td>
                                  <td>{r.assignedDriverName || '—'}</td>
                                  <td>
                                    {r.pickupAddress} → {r.destinationAddress}
                                  </td>
                                  <td>{r.actualDistanceKm} km</td>
                                  <td>
                                    <span className={`badge badge-${r.status}`}>{r.status}</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                      {renderInlineRecordChatter(selectedTruckForm.truckCode)}
                    </div>
                  </div>
                </>
              );
            })()}

            {truckViewMode === 'new' && (
              <>
                <div className="o-form-statusbar">
                  <button
                    type="button"
                    className="btn-erp-secondary"
                    onClick={() => setTruckViewMode('list')}
                  >
                    ← Discard / Back to Tow Trucks List
                  </button>
                  <div className="o-statusbar-status">
                    <span className="o-stage-pill current">Register New Tow Truck</span>
                  </div>
                </div>

                <form onSubmit={handleCreateTruck} className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">New Normalized Unit (dbo.TowTrucks)</span>
                    <h1>{newTruckForm.truckCode}</h1>
                  </div>
                  <div className="erp-group-grid">
                    <div className="erp-group-col">
                      <div className="erp-group-header">UNIT IDENTIFICATION</div>
                      <div className="form-row">
                        <label>Truck Code (Unique)</label>
                        <input
                          type="text"
                          value={newTruckForm.truckCode}
                          onChange={e => setNewTruckForm({ ...newTruckForm, truckCode: e.target.value })}
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>License Plate (Unique)</label>
                        <input
                          type="text"
                          value={newTruckForm.licensePlate}
                          onChange={e => setNewTruckForm({ ...newTruckForm, licensePlate: e.target.value })}
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Truck Model</label>
                        <input
                          type="text"
                          value={newTruckForm.truckModel}
                          onChange={e => setNewTruckForm({ ...newTruckForm, truckModel: e.target.value })}
                          required
                        />
                      </div>
                    </div>
                    <div className="erp-group-col">
                      <div className="erp-group-header">CAPACITY &amp; INITIAL STATION</div>
                      <div className="form-row">
                        <label>Max Payload Capacity (KG)</label>
                        <input
                          type="number"
                          min="1000"
                          max="30000"
                          value={newTruckForm.maxPayloadKg}
                          onChange={e => setNewTruckForm({ ...newTruckForm, maxPayloadKg: e.target.value })}
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Initial Fleet Status</label>
                        <select
                          value={newTruckForm.fleetStatus}
                          onChange={e => setNewTruckForm({ ...newTruckForm, fleetStatus: e.target.value })}
                        >
                          <option value="Available">Available</option>
                          <option value="Maintenance">Maintenance</option>
                          <option value="OffDuty">OffDuty</option>
                        </select>
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Base Coordinates (Lat / Lng)</label>
                        <div className="split-inputs">
                          <input
                            type="number"
                            step="0.0001"
                            value={newTruckForm.currentLat}
                            onChange={e => setNewTruckForm({ ...newTruckForm, currentLat: e.target.value })}
                            required
                          />
                          <input
                            type="number"
                            step="0.0001"
                            value={newTruckForm.currentLng}
                            onChange={e => setNewTruckForm({ ...newTruckForm, currentLng: e.target.value })}
                            required
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                  <button type="submit" className="btn-erp-primary">
                    Save &amp; Register Tow Truck
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {/* ==========================================================================
            CONFIGURATION SECTION 3: DRIVERS (List -> Driver Sheet + Related Info)
           ========================================================================== */}
        {activeTab === 'drivers' && (
          <div className="o-form-sheet">
            {driverViewMode === 'list' && (
              <div className="erp-sheet-pad">
                <div className="card-header-flex" style={{ marginBottom: '12px' }}>
                  <div>
                    <h3>Drivers Directory (dbo.Drivers)</h3>
                    <p className="muted">
                      Normalized driver personnel &amp; payroll profiles decoupled from trucks.
                      Click any driver row to edit their profile, rotate truck assignments, or view
                      historical shifts, dispatched rescues, and cash/payroll records.
                    </p>
                  </div>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Employee Code</th>
                      <th>Driver Full Name</th>
                      <th>Phone &amp; License</th>
                      <th>Active Assigned Truck</th>
                      <th>Compensation (Base / OT)</th>
                      <th>Shift Mode</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.drivers || [])
                      .filter(d => {
                        const q = configSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          d.employeeCode.toLowerCase().includes(q) ||
                          d.fullName.toLowerCase().includes(q) ||
                          d.phone.toLowerCase().includes(q) ||
                          (d.activeTruckCode || '').toLowerCase().includes(q)
                        );
                      })
                      .map(d => (
                        <tr
                          key={d.driverId}
                          className="clickable-row"
                          onClick={() => openDriverRecord(d.driverId)}
                        >
                          <td>
                            <code>{d.employeeCode}</code>
                          </td>
                          <td>
                            <strong>{d.fullName}</strong>
                          </td>
                          <td>
                            {d.phone}
                            <br />
                            <small className="muted">Lic: {d.licenseNumber}</small>
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            {d.activeTruckId ? (
                              <button
                                type="button"
                                className="rel-entity-link"
                                onClick={() => openTruckRecord(d.activeTruckId)}
                              >
                                {d.activeTruckCode}
                              </button>
                            ) : (
                              <span className="muted">Standby / Unassigned</span>
                            )}
                          </td>
                          <td>
                            ${d.baseMonthlySalary} / +${d.overtimeRatePerTow}
                          </td>
                          <td>
                            {d.isWorkingOffDay ? (
                              <span className="badge badge-PendingInsurance">Off-Day OT</span>
                            ) : (
                              <span className="muted">Regular</span>
                            )}
                          </td>
                          <td>
                            <span
                              className={`badge ${
                                d.driverStatus === 'Active' ? 'badge-Done' : 'badge-Draft'
                              }`}
                            >
                              {d.driverStatus}
                            </span>
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn-xs"
                              onClick={() => openDriverRecord(d.driverId)}
                            >
                              Open Driver Sheet
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {driverViewMode === 'form' && editingDriver && (() => {
              const liveDriver =
                (dashboard?.drivers || []).find(d => d.driverId === editingDriver.driverId) ||
                editingDriver;
              const driverAssignments = (dashboard?.driverAssignments || []).filter(
                a => a.driverId === editingDriver.driverId
              );
              const activeAssign = driverAssignments.find(a => !a.endDate);
              const driverTows = (dashboard?.recentRequests || []).filter(
                r => r.assignedDriverId === editingDriver.driverId
              );
              const driverPayroll = (dashboard?.payrollReport || []).find(
                p => p.driverId === editingDriver.driverId
              );
              const driverCashRows = (dashboard?.invoicePayments || []).filter(
                pm => pm.collectedByDriverId === editingDriver.driverId
              );
              return (
                <>
                  <div className="o-form-statusbar">
                    <div className="action-btn-group">
                      <button
                        type="button"
                        className="btn-erp-secondary"
                        onClick={() => setDriverViewMode('list')}
                      >
                        ← Back to Drivers List
                      </button>
                    </div>
                    <div className="o-statusbar-status">
                      <span className="o-stage-pill current">{liveDriver.driverStatus}</span>
                    </div>
                  </div>

                  <div className="erp-sheet-pad">
                    <div className="erp-oe-title">
                      <span className="erp-oe-label">
                        dbo.Drivers Record #{editingDriver.driverId} ({editingDriver.employeeCode})
                      </span>
                      <h1>{editingDriver.fullName}</h1>
                    </div>

                    <div className="erp-group-grid">
                      <form onSubmit={handleSaveDriverContact} className="erp-group-col">
                        <div className="erp-group-header">PERSONNEL &amp; PAYROLL PROFILE (SINGLE-ROW 3NF)</div>
                        <div className="form-row">
                          <label>Full Name &amp; Mobile Phone</label>
                          <div className="split-inputs">
                            <input
                              type="text"
                              value={editingDriver.fullName}
                              onChange={e =>
                                setEditingDriver({ ...editingDriver, fullName: e.target.value })
                              }
                              required
                            />
                            <input
                              type="text"
                              value={editingDriver.phone}
                              onChange={e =>
                                setEditingDriver({ ...editingDriver, phone: e.target.value })
                              }
                              required
                            />
                          </div>
                        </div>

                        <div className="form-row" style={{ marginTop: '8px' }}>
                          <label>Commercial License # &amp; Driver Status</label>
                          <div className="split-inputs">
                            <input
                              type="text"
                              value={editingDriver.licenseNumber}
                              onChange={e =>
                                setEditingDriver({ ...editingDriver, licenseNumber: e.target.value })
                              }
                              required
                            />
                            <select
                              value={editingDriver.driverStatus}
                              onChange={e =>
                                setEditingDriver({ ...editingDriver, driverStatus: e.target.value })
                              }
                            >
                              <option value="Active">Active</option>
                              <option value="OnLeave">OnLeave</option>
                              <option value="Inactive">Inactive</option>
                            </select>
                          </div>
                        </div>

                        <div className="form-row" style={{ marginTop: '8px' }}>
                          <label>Base Monthly Salary ($) &amp; Overtime Rate / Tow ($)</label>
                          <div className="split-inputs">
                            <input
                              type="number"
                              step="10"
                              value={editingDriver.baseMonthlySalary}
                              onChange={e =>
                                setEditingDriver({
                                  ...editingDriver,
                                  baseMonthlySalary: e.target.value
                                })
                              }
                              required
                            />
                            <input
                              type="number"
                              step="0.5"
                              value={editingDriver.overtimeRatePerTow}
                              onChange={e =>
                                setEditingDriver({
                                  ...editingDriver,
                                  overtimeRatePerTow: e.target.value
                                })
                              }
                              required
                            />
                          </div>
                        </div>

                        <div className="form-row" style={{ marginTop: '10px' }}>
                          <label className="erp-toggle-switch">
                            <input
                              type="checkbox"
                              checked={Boolean(editingDriver.isWorkingOffDay)}
                              onChange={e =>
                                setEditingDriver({
                                  ...editingDriver,
                                  isWorkingOffDay: e.target.checked
                                })
                              }
                            />
                            <span>Working Off-Day Shift (Overtime Rate Applicable)</span>
                          </label>
                        </div>

                        <div style={{ marginTop: '12px' }}>
                          <button type="submit" className="btn-primary">
                            Save Driver Profile (dbo.Drivers)
                          </button>
                        </div>
                      </form>

                      <div className="erp-group-col">
                        <div className="erp-group-header">RELATED OPERATIONS OVERVIEW</div>
                        <div className="erp-field-row">
                          <label>Currently Assigned Truck</label>
                          <div className="erp-field-val">
                            {liveDriver.activeTruckId ? (
                              <button
                                type="button"
                                className="rel-entity-link"
                                onClick={() => openTruckRecord(liveDriver.activeTruckId)}
                              >
                                {liveDriver.activeTruckCode}
                              </button>
                            ) : (
                              <span className="muted">Standby / Unassigned</span>
                            )}
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Historical Truck Shifts</label>
                          <div className="erp-field-val">
                            <strong>{driverAssignments.length} Shift Records</strong>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Dispatched Rescues</label>
                          <div className="erp-field-val">
                            <strong>{driverTows.length} Tows</strong>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Net Monthly Payout</label>
                          <div className="erp-field-val">
                            <strong>
                              ${driverPayroll?.netSalaryPayoutAfterCashDeduction ?? editingDriver.baseMonthlySalary}
                            </strong>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="erp-notebook">
                      <div className="erp-notebook-tabs">
                        <button
                          type="button"
                          className={driverNotebookTab === 'assignments' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                          onClick={() => setDriverNotebookTab('assignments')}
                        >
                          Truck Assignment History ({driverAssignments.length})
                        </button>
                        <button
                          type="button"
                          className={driverNotebookTab === 'tows' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                          onClick={() => setDriverNotebookTab('tows')}
                        >
                          Dispatched Rescues ({driverTows.length})
                        </button>
                        <button
                          type="button"
                          className={driverNotebookTab === 'payroll' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                          onClick={() => setDriverNotebookTab('payroll')}
                        >
                          Payroll &amp; On-Scene Cash ({driverCashRows.length})
                        </button>
                      </div>

                      <div className="erp-notebook-page">
                        {driverNotebookTab === 'assignments' && (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Assignment #</th>
                                <th>Tow Truck</th>
                                <th>Start Date</th>
                                <th>End Date</th>
                                <th>Assignment Notes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {driverAssignments.map(a => (
                                <tr
                                  key={a.assignmentId}
                                  className="clickable-row"
                                  onClick={() => openTruckRecord(a.truckId)}
                                >
                                  <td>#{a.assignmentId}</td>
                                  <td>
                                    <span className="rel-entity-link">
                                      {a.truckCode} ({a.truckPlate})
                                    </span>
                                  </td>
                                  <td>{a.startDate}</td>
                                  <td>
                                    {a.endDate ? (
                                      <span className="muted">{a.endDate}</span>
                                    ) : (
                                      <span className="badge badge-Done">Active (NULL EndDate)</span>
                                    )}
                                  </td>
                                  <td>{a.assignmentNotes || '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {driverNotebookTab === 'tows' && (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Request #</th>
                                <th>Customer &amp; Vehicle</th>
                                <th>Truck Used</th>
                                <th>Distance</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {driverTows.map(r => (
                                <tr
                                  key={r.towRequestId}
                                  className="clickable-row"
                                  onClick={() => openTowRequestRecord(r.towRequestId)}
                                >
                                  <td>
                                    <strong>{r.requestNumber}</strong>
                                  </td>
                                  <td>
                                    {r.customerName} • <code>{r.vehiclePlate}</code>
                                  </td>
                                  <td>{r.truckCode || '—'}</td>
                                  <td>{r.actualDistanceKm} km</td>
                                  <td>
                                    <span className={`badge badge-${r.status}`}>{r.status}</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {driverNotebookTab === 'payroll' && (
                          <div>
                            {driverPayroll && (
                              <div className="elig-metrics">
                                <div className="metric-item">
                                  <span>Completed Tows (Month)</span>
                                  <strong>{driverPayroll.completedTowsThisMonth}</strong>
                                </div>
                                <div className="metric-item">
                                  <span>Overtime Earned</span>
                                  <strong className="text-green">+${driverPayroll.overtimePayEarned}</strong>
                                </div>
                                <div className="metric-item">
                                  <span>On-Scene Cash Held</span>
                                  <strong className="text-red">-${driverPayroll.totalCashCollectedByDriver}</strong>
                                </div>
                                <div className="metric-item">
                                  <span>Net Payout</span>
                                  <strong>${driverPayroll.netSalaryPayoutAfterCashDeduction}</strong>
                                </div>
                              </div>
                            )}

                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Payment #</th>
                                  <th>Invoice / Request</th>
                                  <th>Customer</th>
                                  <th>Cash Collected</th>
                                  <th>Paid At</th>
                                </tr>
                              </thead>
                              <tbody>
                                {driverCashRows.map(pm => (
                                  <tr
                                    key={pm.paymentId}
                                    className="clickable-row"
                                    onClick={() => openInvoiceRecord(pm.invoiceId)}
                                  >
                                    <td>#{pm.paymentId}</td>
                                    <td>
                                      <strong>{pm.invoiceNumber}</strong> ({pm.requestNumber})
                                    </td>
                                    <td>{pm.payerName}</td>
                                    <td>
                                      <strong className="text-green">+${pm.amountPaid}</strong>
                                    </td>
                                    <td>{pm.paidAt}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                      {renderInlineRecordChatter(
                        `${editingDriver.fullName} (${editingDriver.employeeCode})`
                      )}
                    </div>
                  </div>
                </>
              );
            })()}

            {driverViewMode === 'new' && (
              <>
                <div className="o-form-statusbar">
                  <button
                    type="button"
                    className="btn-erp-secondary"
                    onClick={() => setDriverViewMode('list')}
                  >
                    ← Discard / Back to Drivers List
                  </button>
                  <div className="o-statusbar-status">
                    <span className="o-stage-pill current">Register New Driver</span>
                  </div>
                </div>

                <form onSubmit={handleCreateDriver} className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">New Normalized Driver (dbo.Drivers)</span>
                    <h1>{newDriverForm.fullName || newDriverForm.employeeCode}</h1>
                  </div>
                  <div className="erp-group-grid">
                    <div className="erp-group-col">
                      <div className="erp-group-header">PERSONNEL IDENTITY</div>
                      <div className="form-row">
                        <label>Employee Code (Unique)</label>
                        <input
                          type="text"
                          value={newDriverForm.employeeCode}
                          onChange={e =>
                            setNewDriverForm({ ...newDriverForm, employeeCode: e.target.value })
                          }
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Full Name</label>
                        <input
                          type="text"
                          placeholder="e.g. Nabil Mansour"
                          value={newDriverForm.fullName}
                          onChange={e =>
                            setNewDriverForm({ ...newDriverForm, fullName: e.target.value })
                          }
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Mobile Phone &amp; Commercial License #</label>
                        <div className="split-inputs">
                          <input
                            type="text"
                            value={newDriverForm.phone}
                            onChange={e =>
                              setNewDriverForm({ ...newDriverForm, phone: e.target.value })
                            }
                            required
                          />
                          <input
                            type="text"
                            value={newDriverForm.licenseNumber}
                            onChange={e =>
                              setNewDriverForm({ ...newDriverForm, licenseNumber: e.target.value })
                            }
                            required
                          />
                        </div>
                      </div>
                    </div>

                    <div className="erp-group-col">
                      <div className="erp-group-header">COMPENSATION &amp; SHIFT</div>
                      <div className="form-row">
                        <label>Base Monthly Salary ($) &amp; OT Rate / Tow ($)</label>
                        <div className="split-inputs">
                          <input
                            type="number"
                            step="10"
                            value={newDriverForm.baseMonthlySalary}
                            onChange={e =>
                              setNewDriverForm({ ...newDriverForm, baseMonthlySalary: e.target.value })
                            }
                            required
                          />
                          <input
                            type="number"
                            step="0.5"
                            value={newDriverForm.overtimeRatePerTow}
                            onChange={e =>
                              setNewDriverForm({
                                ...newDriverForm,
                                overtimeRatePerTow: e.target.value
                              })
                            }
                            required
                          />
                        </div>
                      </div>
                      <div className="form-row" style={{ marginTop: '12px' }}>
                        <label className="erp-toggle-switch">
                          <input
                            type="checkbox"
                            checked={newDriverForm.isWorkingOffDay}
                            onChange={e =>
                              setNewDriverForm({
                                ...newDriverForm,
                                isWorkingOffDay: e.target.checked
                              })
                            }
                          />
                          <span>Working Off-Day Shift</span>
                        </label>
                      </div>
                    </div>
                  </div>
                  <button type="submit" className="btn-erp-primary">
                    Save &amp; Register Driver
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {/* ==========================================================================
            NORMALIZED TAB B: HISTORICAL TARIFFS (List -> Tariff Sheet + Related Invoices)
           ========================================================================== */}
        {activeTab === 'tariffs' && (
          <div className="o-form-sheet">
            {tariffViewMode === 'list' && (
              <div className="erp-sheet-pad">
                <div className="card-header-flex" style={{ marginBottom: '12px' }}>
                  <div>
                    <h3>Tariff Schedule Catalog (dbo.Tariffs)</h3>
                    <p className="muted">
                      Click any tariff row to inspect its effective rate schedule and all{' '}
                      <code>dbo.TowInvoices</code> snapshot-billed under it, or click{' '}
                      <strong>+ New Tariff</strong> to publish a new schedule without altering
                      historical invoices.
                    </p>
                  </div>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Tariff Code</th>
                      <th>Name &amp; Category</th>
                      <th>Base Fee</th>
                      <th>Rate / KM</th>
                      <th>Night Surcharge</th>
                      <th>Effective Window</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.tariffs || []).map(t => (
                      <tr
                        key={t.tariffId}
                        className="clickable-row"
                        onClick={() => openTariffRecord(t.tariffId)}
                      >
                        <td>
                          <strong>{t.tariffCode}</strong>
                        </td>
                        <td>
                          <strong>{t.tariffName}</strong>
                          <br />
                          <small className="muted">{t.serviceCategory}</small>
                        </td>
                        <td>${t.baseFee}</td>
                        <td>${t.pricePerKm}/km</td>
                        <td>+${t.nightSurcharge}</td>
                        <td>
                          {t.effectiveFrom} → {t.effectiveTo || 'Open'}
                        </td>
                        <td>
                          {t.isActive ? (
                            <span className="badge badge-Done">Active</span>
                          ) : (
                            <span className="badge badge-Draft">Historical</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tariffViewMode === 'form' && (() => {
              const tf = (dashboard?.tariffs || []).find(
                x => x.tariffId === Number(selectedTariffId)
              );
              if (!tf) return null;
              const linkedInvoices = (dashboard?.invoices || []).filter(
                inv => inv.tariffId === tf.tariffId
              );
              return (
                <>
                  <div className="o-form-statusbar">
                    <button
                      type="button"
                      className="btn-erp-secondary"
                      onClick={() => setTariffViewMode('list')}
                    >
                      ← Back to Tariffs List
                    </button>
                    <div className="o-statusbar-status">
                      <span className="o-stage-pill current">
                        {tf.isActive ? 'Active Schedule' : 'Historical Sealed Schedule'}
                      </span>
                    </div>
                  </div>
                  <div className="erp-sheet-pad">
                    <div className="erp-oe-title">
                      <span className="erp-oe-label">dbo.Tariffs Record #{tf.tariffId}</span>
                      <h1>
                        {tf.tariffCode} — {tf.tariffName}
                      </h1>
                    </div>
                    <div className="erp-group-grid">
                      <div className="erp-group-col">
                        <div className="erp-group-header">RATE COMPONENTS</div>
                        <div className="erp-field-row">
                          <label>Service Category</label>
                          <div className="erp-field-val">
                            <strong>{tf.serviceCategory}</strong>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Base Dispatch Fee</label>
                          <div className="erp-field-val">${tf.baseFee}</div>
                        </div>
                        <div className="erp-field-row">
                          <label>Price Per Kilometer</label>
                          <div className="erp-field-val">${tf.pricePerKm}/KM</div>
                        </div>
                        <div className="erp-field-row">
                          <label>Night Surcharge</label>
                          <div className="erp-field-val">+${tf.nightSurcharge}</div>
                        </div>
                      </div>
                      <div className="erp-group-col">
                        <div className="erp-group-header">EFFECTIVE VALIDITY</div>
                        <div className="erp-field-row">
                          <label>Effective From</label>
                          <div className="erp-field-val">{tf.effectiveFrom}</div>
                        </div>
                        <div className="erp-field-row">
                          <label>Effective To</label>
                          <div className="erp-field-val">{tf.effectiveTo || 'Open-Ended'}</div>
                        </div>
                      </div>
                    </div>

                    <div className="erp-notebook">
                      <div className="erp-notebook-tabs">
                        <button type="button" className="erp-nb-tab active">
                          Related Tow Invoices Snapshot-Billed Under {tf.tariffCode} ({linkedInvoices.length})
                        </button>
                      </div>
                      <div className="erp-notebook-page">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Invoice #</th>
                              <th>Request #</th>
                              <th>Customer</th>
                              <th>Snapshot Rates</th>
                              <th>Total</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {linkedInvoices.map(inv => (
                              <tr
                                key={inv.invoiceId}
                                className="clickable-row"
                                onClick={() => openInvoiceRecord(inv.invoiceId)}
                              >
                                <td>
                                  <strong>{inv.invoiceNumber}</strong>
                                </td>
                                <td>
                                  <code>{inv.requestNumber}</code>
                                </td>
                                <td>{inv.customerName}</td>
                                <td>
                                  Base ${inv.appliedBaseFee} • ${inv.appliedPricePerKm}/km
                                </td>
                                <td>
                                  <strong>${inv.totalAmount}</strong>
                                </td>
                                <td>
                                  <span className="badge badge-Approved">{inv.invoiceStatus}</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {renderInlineRecordChatter(tf.tariffCode)}
                    </div>
                  </div>
                </>
              );
            })()}

            {tariffViewMode === 'new' && (
              <>
                <div className="o-form-statusbar">
                  <button
                    type="button"
                    className="btn-erp-secondary"
                    onClick={() => setTariffViewMode('list')}
                  >
                    ← Back to Tariffs List
                  </button>
                  <div className="o-statusbar-status">
                    <span className="o-stage-pill current">Publish New Tariff</span>
                  </div>
                </div>
                <form onSubmit={handleCreateTariff} className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">New Schedule (dbo.Tariffs)</span>
                    <h1>{newTariffForm.tariffCode}</h1>
                  </div>
                  <div className="erp-group-grid">
                    <div className="erp-group-col">
                      <div className="form-row">
                        <label>Tariff Code</label>
                        <input
                          type="text"
                          value={newTariffForm.tariffCode}
                          onChange={e =>
                            setNewTariffForm({ ...newTariffForm, tariffCode: e.target.value })
                          }
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Tariff Name</label>
                        <input
                          type="text"
                          value={newTariffForm.tariffName}
                          onChange={e =>
                            setNewTariffForm({ ...newTariffForm, tariffName: e.target.value })
                          }
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Service Category &amp; Effective From</label>
                        <div className="split-inputs">
                          <select
                            value={newTariffForm.serviceCategory}
                            onChange={e =>
                              setNewTariffForm({
                                ...newTariffForm,
                                serviceCategory: e.target.value
                              })
                            }
                          >
                            <option value="Mechanical">Mechanical</option>
                            <option value="Accident">Accident</option>
                            <option value="All">All</option>
                          </select>
                          <input
                            type="date"
                            value={newTariffForm.effectiveFrom}
                            onChange={e =>
                              setNewTariffForm({
                                ...newTariffForm,
                                effectiveFrom: e.target.value
                              })
                            }
                            required
                          />
                        </div>
                      </div>
                    </div>
                    <div className="erp-group-col">
                      <div className="form-row">
                        <label>Base Fee ($) &amp; Price / KM ($)</label>
                        <div className="split-inputs">
                          <input
                            type="number"
                            step="0.5"
                            value={newTariffForm.baseFee}
                            onChange={e =>
                              setNewTariffForm({ ...newTariffForm, baseFee: e.target.value })
                            }
                            required
                          />
                          <input
                            type="number"
                            step="0.05"
                            value={newTariffForm.pricePerKm}
                            onChange={e =>
                              setNewTariffForm({ ...newTariffForm, pricePerKm: e.target.value })
                            }
                            required
                          />
                        </div>
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Night Surcharge ($)</label>
                        <input
                          type="number"
                          step="0.5"
                          value={newTariffForm.nightSurcharge}
                          onChange={e =>
                            setNewTariffForm({
                              ...newTariffForm,
                              nightSurcharge: e.target.value
                            })
                          }
                          required
                        />
                      </div>
                    </div>
                  </div>
                  <button type="submit" className="btn-erp-primary">
                    Publish New Tariff (Preserve Historical Invoices)
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {/* ==========================================================================
            NORMALIZED TAB C: INVOICES & PAYMENTS (List -> Invoice Sheet + Payments)
           ========================================================================== */}
        {activeTab === 'billing' && (
          <div className="o-form-sheet">
            {invoiceViewMode === 'list' && (
              <div className="erp-sheet-pad">
                <div className="queue-header" style={{ marginBottom: '12px' }}>
                  <div>
                    <h3>Tow Invoices Directory (dbo.TowInvoices)</h3>
                    <p className="muted">
                      Click any invoice row to inspect its immutable tariff snapshot, separate
                      Insurer vs. Customer obligations, linked Tow Request, and individual{' '}
                      <code>dbo.InvoicePayments</code> ledger rows.
                    </p>
                  </div>
                  <div className="elig-metrics" style={{ marginBottom: 0 }}>
                    <div className="metric-item">
                      <span>Unpaid Insurer Receivable</span>
                      <strong className="text-amber">
                        ${Number(kpis.unpaidInsurerBalance || 0).toLocaleString()}
                      </strong>
                    </div>
                    <div className="metric-item">
                      <span>Unpaid Customer Receivable</span>
                      <strong className="text-red">
                        ${Number(kpis.unpaidCustomerBalance || 0).toLocaleString()}
                      </strong>
                    </div>
                  </div>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Invoice #</th>
                      <th>Request / Tariff</th>
                      <th>Insurer Obligation (Billed / Paid / Due)</th>
                      <th>Customer Obligation (Billed / Paid / Due)</th>
                      <th>Total</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.invoices || [])
                      .filter(inv => {
                        const q = billingSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          inv.invoiceNumber.toLowerCase().includes(q) ||
                          inv.requestNumber.toLowerCase().includes(q) ||
                          inv.customerName.toLowerCase().includes(q) ||
                          (inv.insuranceProviderName || '').toLowerCase().includes(q)
                        );
                      })
                      .map(inv => {
                        const canPayInsurer = Number(inv.insurerBalanceDue) > 0;
                        const canPayCustomer = Number(inv.customerBalanceDue) > 0;
                        return (
                          <tr
                            key={inv.invoiceId}
                            className="clickable-row"
                            onClick={() => openInvoiceRecord(inv.invoiceId)}
                          >
                            <td>
                              <strong>{inv.invoiceNumber}</strong>
                              <br />
                              <small className="muted">{inv.issuedAt}</small>
                            </td>
                            <td>
                              <code>{inv.requestNumber}</code>
                              <br />
                              <small className="muted">
                                {inv.tariffCode} (${inv.appliedBaseFee} + ${inv.appliedPricePerKm}/km)
                              </small>
                            </td>
                            <td>
                              <div>
                                <strong>{inv.insuranceProviderName || 'Direct Cash (None)'}</strong>
                              </div>
                              <small>
                                Billed: ${inv.insurerBilledAmount} | Paid: ${inv.insurerPaidAmount} |{' '}
                                <strong className={canPayInsurer ? 'text-amber' : 'text-green'}>
                                  Due: ${inv.insurerBalanceDue}
                                </strong>
                              </small>
                            </td>
                            <td>
                              <div>
                                <strong>{inv.customerName}</strong>
                              </div>
                              <small>
                                Billed: ${inv.customerBilledAmount} | Paid: ${inv.customerPaidAmount} |{' '}
                                <strong className={canPayCustomer ? 'text-red' : 'text-green'}>
                                  Due: ${inv.customerBalanceDue}
                                </strong>
                              </small>
                            </td>
                            <td>
                              <strong>${inv.totalAmount}</strong>
                            </td>
                            <td>
                              <span
                                className={`badge ${
                                  inv.invoiceStatus === 'Paid'
                                    ? 'badge-Done'
                                    : inv.invoiceStatus === 'PartiallyPaid'
                                    ? 'badge-PendingInsurance'
                                    : 'badge-Draft'
                                }`}
                              >
                                {inv.invoiceStatus}
                              </span>
                            </td>
                            <td onClick={e => e.stopPropagation()}>
                              <div className="action-btn-group">
                                <button
                                  type="button"
                                  className="btn-xs"
                                  onClick={() => openInvoiceRecord(inv.invoiceId)}
                                >
                                  Open Sheet
                                </button>
                                {(canPayInsurer || canPayCustomer) && (
                                  <button
                                    type="button"
                                    className="btn-xs btn-approve"
                                    onClick={() => {
                                      const defaultPayer = canPayInsurer
                                        ? 'InsuranceProvider'
                                        : 'Customer';
                                      const defaultAmt = canPayInsurer
                                        ? Number(inv.insurerBalanceDue)
                                        : Number(inv.customerBalanceDue);
                                      setPaymentForm({
                                        payerType: defaultPayer,
                                        amountPaid: defaultAmt,
                                        paymentMethod:
                                          defaultPayer === 'InsuranceProvider'
                                            ? 'BankTransfer'
                                            : 'OnSceneCash',
                                        referenceNumber: `PAY-${inv.invoiceId}-${Math.floor(
                                          100 + Math.random() * 900
                                        )}`,
                                        collectedByDriverId: '',
                                        notes: 'Partial / full obligation settlement'
                                      });
                                      setPaymentModalInvoice(inv);
                                    }}
                                  >
                                    + Pay
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
            )}

            {invoiceViewMode === 'form' && (() => {
              const inv = (dashboard?.invoices || []).find(
                x => x.invoiceId === Number(selectedInvoiceId)
              );
              if (!inv) return null;
              const invPayments = (dashboard?.invoicePayments || []).filter(
                pm => pm.invoiceId === inv.invoiceId
              );
              const canPayInsurer = Number(inv.insurerBalanceDue) > 0;
              const canPayCustomer = Number(inv.customerBalanceDue) > 0;
              return (
                <>
                  <div className="o-form-statusbar">
                    <div className="action-btn-group">
                      <button
                        type="button"
                        className="btn-erp-secondary"
                        onClick={() => setInvoiceViewMode('list')}
                      >
                        ← Back to Invoices List
                      </button>
                      {(canPayInsurer || canPayCustomer) && (
                        <button
                          type="button"
                          className="btn-erp-primary"
                          onClick={() => {
                            const defaultPayer = canPayInsurer ? 'InsuranceProvider' : 'Customer';
                            const defaultAmt = canPayInsurer
                              ? Number(inv.insurerBalanceDue)
                              : Number(inv.customerBalanceDue);
                            setPaymentForm({
                              payerType: defaultPayer,
                              amountPaid: defaultAmt,
                              paymentMethod:
                                defaultPayer === 'InsuranceProvider' ? 'BankTransfer' : 'OnSceneCash',
                              referenceNumber: `PAY-${inv.invoiceId}-${Math.floor(
                                100 + Math.random() * 900
                              )}`,
                              collectedByDriverId: '',
                              notes: 'Partial / full obligation settlement'
                            });
                            setPaymentModalInvoice(inv);
                          }}
                        >
                          + Record Partial / Full Payment
                        </button>
                      )}
                    </div>
                    <div className="o-statusbar-status">
                      <span className="o-stage-pill current">{inv.invoiceStatus}</span>
                    </div>
                  </div>

                  <div className="erp-sheet-pad">
                    <div className="erp-oe-title">
                      <span className="erp-oe-label">dbo.TowInvoices Record #{inv.invoiceId}</span>
                      <h1>{inv.invoiceNumber}</h1>
                    </div>

                    <div className="erp-group-grid">
                      <div className="erp-group-col">
                        <div className="erp-group-header">LINKED 3NF ENTITIES &amp; TARIFF SNAPSHOT</div>
                        <div className="erp-field-row">
                          <label>Tow Request</label>
                          <div className="erp-field-val">
                            <button
                              type="button"
                              className="rel-entity-link"
                              onClick={() => openTowRequestRecord(inv.towRequestId)}
                            >
                              {inv.requestNumber}
                            </button>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Customer</label>
                          <div className="erp-field-val">
                            <button
                              type="button"
                              className="rel-entity-link"
                              onClick={() => openCustomerRecord(inv.customerId)}
                            >
                              {inv.customerName}
                            </button>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Snapshot Tariff</label>
                          <div className="erp-field-val">
                            <button
                              type="button"
                              className="rel-entity-link"
                              onClick={() => openTariffRecord(inv.tariffId)}
                            >
                              {inv.tariffCode}
                            </button>{' '}
                            <small className="muted">
                              (Base ${inv.appliedBaseFee} • ${inv.appliedPricePerKm}/km • Night +$
                              {inv.appliedNightSurcharge})
                            </small>
                          </div>
                        </div>
                      </div>

                      <div className="erp-group-col">
                        <div className="erp-group-header">SEPARATE INSURER VS CUSTOMER BALANCES</div>
                        <div className="erp-field-row">
                          <label>Insurer ({inv.insuranceProviderName || 'None'})</label>
                          <div className="erp-field-val">
                            Billed: <strong>${inv.insurerBilledAmount}</strong> | Paid: $
                            {inv.insurerPaidAmount} |{' '}
                            <strong className={canPayInsurer ? 'text-amber' : 'text-green'}>
                              Due: ${inv.insurerBalanceDue}
                            </strong>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Customer ({inv.customerName})</label>
                          <div className="erp-field-val">
                            Billed: <strong>${inv.customerBilledAmount}</strong> | Paid: $
                            {inv.customerPaidAmount} |{' '}
                            <strong className={canPayCustomer ? 'text-red' : 'text-green'}>
                              Due: ${inv.customerBalanceDue}
                            </strong>
                          </div>
                        </div>
                        <div className="erp-field-row">
                          <label>Total Invoice</label>
                          <div className="erp-field-val">
                            <strong>${inv.totalAmount}</strong>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="erp-notebook">
                      <div className="erp-notebook-tabs">
                        <button type="button" className="erp-nb-tab active">
                          Individual Payment Ledger Rows in dbo.InvoicePayments ({invPayments.length})
                        </button>
                      </div>
                      <div className="erp-notebook-page">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Payment ID</th>
                              <th>Payer Type</th>
                              <th>Payer Entity</th>
                              <th>Amount Paid</th>
                              <th>Method &amp; Ref</th>
                              <th>Recorded By</th>
                              <th>Paid At</th>
                            </tr>
                          </thead>
                          <tbody>
                            {invPayments.map(pm => (
                              <tr key={pm.paymentId}>
                                <td>#{pm.paymentId}</td>
                                <td>
                                  <span
                                    className={`badge ${
                                      pm.payerType === 'InsuranceProvider'
                                        ? 'badge-Approved'
                                        : 'badge-PendingInsurance'
                                    }`}
                                  >
                                    {pm.payerType}
                                  </span>
                                </td>
                                <td>{pm.payerName}</td>
                                <td>
                                  <strong className="text-green">+${pm.amountPaid}</strong>
                                </td>
                                <td>
                                  {pm.paymentMethod} • <code>{pm.referenceNumber}</code>
                                </td>
                                <td>
                                  <code>{pm.recordedByUsername}</code>
                                  {pm.collectedByDriverName
                                    ? ` (Driver: ${pm.collectedByDriverName})`
                                    : ''}
                                </td>
                                <td>{pm.paidAt}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {renderInlineRecordChatter(inv.invoiceNumber)}
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {/* TAB 3: DISPATCH LIFECYCLE BOARD, QUEUE & DRIVER PAYROLL */}
        {activeTab === 'queue' && (
          <div className="card">
            <div className="queue-header">
              <div>
                <h3>Dispatch Lifecycle Board</h3>
                <p className="muted">
                  Manage roadside operations across intake, insurer verification, fleet dispatch,
                  and final settlement. Closed tickets are permanently sealed for audit compliance.
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
                  className={queueViewMode === 'shifts' ? 'btn-xs active-view' : 'btn-xs'}
                  onClick={() => setQueueViewMode('shifts')}
                >
                  Fleet Shifts
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
                                        handleLifecycleChange(r.towRequestId, 'Rejected')
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
                                r.status === 'Rejected') && (
                                <button
                                  className="btn-xs btn-locked"
                                  title="Verify compliance seal on closed record"
                                  onClick={() => handleTestTriggerLock(r.towRequestId)}
                                >
                                  Audit-Sealed • Verify
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

            {/* VIEW 2: DETAILED TABLE VIEW (Click any row to open Normalized Tow Request Sheet) */}
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
                      <tr
                        key={r.towRequestId}
                        className="clickable-row"
                        onClick={() => openTowRequestRecord(r.towRequestId)}
                      >
                        <td>
                          <strong>{r.requestNumber}</strong>
                        </td>
                        <td>
                          {r.customerName}
                          <br />
                          <span className="muted">{r.policyNumber || 'Direct Cash'}</span>
                        </td>
                        <td>
                          <code>{r.vehiclePlate}</code>
                        </td>
                        <td>{r.issueType}</td>
                        <td>
                          {r.pickupAddress}
                          <br />
                          {r.destinationAddress}
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
                        <td onClick={e => e.stopPropagation()}>
                          <div className="action-btn-group">
                            <button
                              type="button"
                              className="btn-xs"
                              onClick={() => openTowRequestRecord(r.towRequestId)}
                            >
                              Open Sheet
                            </button>
                            {(r.status === 'Done' ||
                              r.status === 'UnableToLoad' ||
                              r.status === 'Rejected') && (
                              <button
                                className="btn-xs btn-locked"
                                onClick={() => handleTestTriggerLock(r.towRequestId)}
                              >
                                Verify Seal
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* VIEW 2B: NORMALIZED TOW REQUEST DETAIL SHEET + INLINE ODOO CHANGE LOG */}
            {queueViewMode === 'detail' &&
              renderTowDetailSheet('← Back to Tow Requests List', () =>
                setQueueViewMode('table')
              )}

            {/* VIEW 3: DRIVER PAYROLL, OVERTIME (7 PM - 7 AM & OFF-DAY) & CASH DEDUCTION REPORT */}
            {queueViewMode === 'payroll' && (
              <div>
                <h4 style={{ marginBottom: '12px' }}>
                  Driver Payroll, Night-Shift Overtime (19:00–07:00 / Off-Day) &amp; On-Scene Cash
                  Settlement
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

            {/* VIEW 4: OPERATIONAL FLEET SHIFTS (Assign / Rotate Driver <-> Tow Truck) */}
            {queueViewMode === 'shifts' && (
              <div className="two-col-grid" style={{ marginTop: '12px' }}>
                <div className="optimistic-box">
                  <h4>Assign / Rotate Active Fleet Shift</h4>
                  <p className="muted">
                    Operational shift desk: closes any prior open assignment with an{' '}
                    <code>EndDate</code> and starts a new active shift without modifying master
                    Driver or Tow Truck configuration records.
                  </p>
                  <form onSubmit={e => handleAssignDriverToTruck(e)}>
                    <div className="form-row">
                      <label>Driver</label>
                      <select
                        value={assignDriverForm.driverId}
                        onChange={e =>
                          setAssignDriverForm({
                            ...assignDriverForm,
                            driverId: Number(e.target.value)
                          })
                        }
                      >
                        {(dashboard?.drivers || []).map(d => (
                          <option key={d.driverId} value={d.driverId}>
                            {d.fullName} ({d.employeeCode}) — Current: {d.activeTruckCode}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-row" style={{ marginTop: '8px' }}>
                      <label>Tow Truck</label>
                      <select
                        value={assignDriverForm.truckId}
                        onChange={e =>
                          setAssignDriverForm({
                            ...assignDriverForm,
                            truckId: Number(e.target.value)
                          })
                        }
                      >
                        {(dashboard?.trucks || []).map(t => (
                          <option key={t.truckId} value={t.truckId}>
                            {t.truckCode} — {t.truckModel} (Plate {t.licensePlate})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-row" style={{ marginTop: '8px' }}>
                      <label>Shift Notes</label>
                      <input
                        type="text"
                        value={assignDriverForm.assignmentNotes}
                        onChange={e =>
                          setAssignDriverForm({
                            ...assignDriverForm,
                            assignmentNotes: e.target.value
                          })
                        }
                      />
                    </div>
                    <button type="submit" className="btn-primary" style={{ marginTop: '12px' }}>
                      Assign / Rotate Shift
                    </button>
                  </form>
                </div>

                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Driver</th>
                        <th>Tow Truck</th>
                        <th>Start Date</th>
                        <th>Shift State</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(dashboard?.driverAssignments || []).map(a => (
                        <tr key={a.assignmentId}>
                          <td>
                            <strong>{a.driverName}</strong> ({a.employeeCode})
                          </td>
                          <td>
                            <code>{a.truckCode}</code>
                          </td>
                          <td>{a.startDate}</td>
                          <td>
                            {a.endDate ? (
                              <span className="muted">Ended {a.endDate}</span>
                            ) : (
                              <span className="badge badge-Done">Active Shift</span>
                            )}
                          </td>
                          <td>
                            {!a.endDate && (
                              <button
                                type="button"
                                className="btn-xs btn-warn"
                                onClick={() => handleEndAssignment(a.assignmentId)}
                              >
                                End Shift
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 4: MULTI-DESK SYNCHRONIZATION, SESSION_CONTEXT AUDIT & SYSTEM INTEGRITY */}
        {activeTab === 'concurrency' && (
          <div>
            <div className="two-col-grid">
              <div className="card">
                <h3>Multi-Dispatcher Policy Quota Guard</h3>
                <p className="muted">
                  Prevents policy quota over-allocation when multiple dispatch stations approve
                  claims on the same customer policy simultaneously. Run a live dual-desk diagnostic
                  to verify real-time quota serialization and distinct{' '}
                  <code>SESSION_CONTEXT</code> dispatcher attribution.
                </p>

                <button
                  className="btn-primary"
                  style={{ marginTop: '14px' }}
                  onClick={handleSimulateConcurrencyRace}
                  disabled={concurrencyRunning}
                >
                  {concurrencyRunning
                    ? 'Running Multi-Desk Quota Check...'
                    : 'Run Dual-Dispatcher Quota Diagnostic'}
                </button>

                {concurrencyResult && (
                  <div className="lab-result-box" style={{ marginTop: '16px' }}>
                    <h4>
                      {concurrencyResult.policyTested} • Remaining Quota:{' '}
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
                          <small>Latency: {o.durationMs} ms</small>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="card">
                <h3>Concurrent Ticket Revision Control</h3>
                <p className="muted">
                  Protects active call intake tickets with automatic revision tokens so an operator
                  never overwrites a colleague&apos;s updates with outdated form state.
                </p>

                {dashboard?.recentRequests
                  ?.filter(
                    r => r.status === 'Draft' || r.status === 'PendingInsurance'
                  )
                  .slice(0, 1)
                  .map(req => (
                    <div key={req.towRequestId} className="optimistic-box">
                      <div className="metric-item">
                        <span>Active Ticket</span>
                        <strong>{req.requestNumber}</strong>
                      </div>
                      <div className="metric-item">
                        <span>Current Revision Token</span>
                        <code>{req.rowVerHex}</code>
                      </div>

                      <div className="form-row">
                        <label>Dispatch Notes</label>
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
                          Save Dispatch Notes
                        </button>
                        <button
                          className="btn-danger"
                          onClick={() => handleOptimisticUpdate(req, true)}
                        >
                          Verify Outdated Token Protection
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
                    <h4>Revision Check ({optimisticResult.status})</h4>
                    <p>{optimisticResult.message || optimisticResult.error}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="card" style={{ marginTop: '16px' }}>
              <h3>
                Immutable Audit Trail (dbo.TowAuditLogs) — Actual Dispatcher via SQL{' '}
                <code>SESSION_CONTEXT</code>
              </h3>
              <p className="muted">
                Every database connection sets and validates <code>SESSION_CONTEXT</code> (
                <code>AppUserId</code>, <code>AppUsername</code>, <code>AppFullName</code>) via{' '}
                <code>dbo.usp_SetDispatcherSessionContext</code> so{' '}
                <code>trg_TowRequests_ImmutabilityAndAudit</code> records the exact authenticated
                dispatcher alongside the pooled <code>EXECUTE</code>-only SQL login.
              </p>

              <div className="table-scroll" style={{ marginTop: '12px' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Audit #</th>
                      <th>Request #</th>
                      <th>Transition</th>
                      <th>Authenticated Dispatcher (SESSION_CONTEXT)</th>
                      <th>Pooled SQL Login</th>
                      <th>Audit Note</th>
                      <th>Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(dashboard?.auditLogs || []).map(a => (
                      <tr key={a.auditId}>
                        <td>#{a.auditId}</td>
                        <td>
                          <strong>{a.requestNumber}</strong>
                        </td>
                        <td>
                          <code>{a.oldStatus}</code> →{' '}
                          <span className={`badge badge-${a.newStatus}`}>{a.newStatus}</span>
                        </td>
                        <td>
                          <strong>{a.changedBy}</strong>
                          {a.dispatcherUserId ? ` (ID #${a.dispatcherUserId})` : ''}
                        </td>
                        <td>
                          <code>{a.sqlLoginName}</code>
                        </td>
                        <td>{a.actionNote}</td>
                        <td>{a.changedAt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: NATIONAL DISPATCH ARCHIVE */}
        {activeTab === 'performance' && (
          <div className="card">
            {archiveViewMode === 'detail' ? (
              renderTowDetailSheet('← Back to Archive List', () => setArchiveViewMode('list'))
            ) : (
              <>
                <h3>
                  National Dispatch Archive ({kpis.totalTowRequests?.toLocaleString()} Normalized Records)
                </h3>
                <p className="muted">
                  Instant historical lookup across{' '}
                  <strong>{kpis.totalTowRequests?.toLocaleString()} roadside assistance records</strong>{' '}
                  joining <code>dbo.TowRequests</code>, <code>dbo.Vehicles</code>, and{' '}
                  <code>dbo.TowInvoices</code> via covering &amp; filtered indexes and{' '}
                  <code>EXECUTE</code>-only stored procedures. Click any tow row to open its Tow Info
                  and Change Log.
                </p>

                <div className="elig-metrics" style={{ marginTop: '12px', marginBottom: '12px' }}>
                  <div className="metric-item">
                    <span>SQL Login / Role</span>
                    <strong>
                      <code>{kpis.connectedSqlLogin || 'tow_cad_app_login'}</code> (EXECUTE-Only)
                    </strong>
                  </div>
                  <div className="metric-item">
                    <span>Direct Table SELECT</span>
                    <strong className="text-green">
                      {kpis.directTableSelectAllowed === 0
                        ? 'DENIED (Least-Privilege Enforced)'
                        : 'Restricted'}
                    </strong>
                  </div>
                  <div className="metric-item">
                    <span>SESSION_CONTEXT Operator</span>
                    <strong>
                      <code>{kpis.sessionUsername || currentUser.username}</code>
                    </strong>
                  </div>
                </div>

                <div className="perf-filter-bar">
                  <div>
                    <label>Search Mode</label>
                    <select value={perfMode} onChange={e => setPerfMode(e.target.value)}>
                      <option value="date_status">Date Range &amp; Status</option>
                      <option value="plate">Vehicle Plate History</option>
                      <option value="policy">Policy &amp; Incident History</option>
                    </select>
                  </div>
                  <div>
                    <label>Dispatch Status</label>
                    <select value={perfStatus} onChange={e => setPerfStatus(e.target.value)}>
                      <option value="Done">Completed (Done)</option>
                      <option value="InProgress">In Progress</option>
                      <option value="Approved">Approved</option>
                      <option value="UnableToLoad">Unable to Load</option>
                      <option value="Rejected">Rejected</option>
                    </select>
                  </div>
                  <div>
                    <label>From Date</label>
                    <input
                      type="date"
                      value={perfStart}
                      onChange={e => setPerfStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <label>To Date</label>
                    <input
                      type="date"
                      value={perfEnd}
                      onChange={e => setPerfEnd(e.target.value)}
                    />
                  </div>
                  <div>
                    <label>Vehicle Plate</label>
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
                      {perfLoading ? 'Searching...' : 'Search Archive'}
                    </button>
                    <button
                      className="btn-secondary"
                      title="Run automated input sanitization diagnostic"
                      onClick={() => {
                        const sqli = "' OR 1=1 --";
                        setPerfMode('plate');
                        setPerfPlate(sqli);
                        runPerformanceQuery('plate', sqli);
                      }}
                    >
                      Security Self-Check
                    </button>
                  </div>
                </div>

                {perfResult && (
                  <div className="perf-results">
                    <div className="elig-metrics">
                      <div className="metric-item">
                        <span>Query Latency</span>
                        <strong className="text-green">{perfResult.elapsedMs} ms</strong>
                      </div>
                      <div className="metric-item">
                        <span>Matched Records</span>
                        <strong>{perfResult.rowCountReturned}</strong>
                      </div>
                      <div className="metric-item">
                        <span>Final Execution Plan Indexes</span>
                        <strong>
                          <code>{perfResult.indexUsed}</code>
                        </strong>
                      </div>
                      <div className="metric-item">
                        <span>Plan Characteristics</span>
                        <strong className="text-green">{perfResult.planCharacteristics}</strong>
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
                            <th>Road Distance &amp; Source</th>
                            <th>Insurer ($)</th>
                            <th>Customer ($)</th>
                            <th>Invoice</th>
                          </tr>
                        </thead>
                        <tbody>
                          {perfResult.rows?.slice(0, 50).map(r => (
                            <tr
                              key={r.towRequestId}
                              className="clickable-row"
                              onClick={() => openTowRequestRecord(r.towRequestId, true)}
                              title={`Click to open ${r.requestNumber} Tow Info & Change Log`}
                            >
                              <td>
                                <strong>{r.requestNumber}</strong>
                              </td>
                              <td>{r.createdAt}</td>
                              <td>
                                <code>{r.vehiclePlate}</code>
                              </td>
                              <td>{r.vehicleModel}</td>
                              <td>{r.issueType}</td>
                              <td>
                                <span className={`badge badge-${r.status}`}>{r.status}</span>
                              </td>
                              <td>
                                <strong>{r.actualDistanceKm} km</strong>{' '}
                                <small className="muted">({r.distanceSource})</small>
                              </td>
                              <td>${r.insurerBilledAmount}</td>
                              <td>${r.overageAmount}</td>
                              <td>
                                <span
                                  className={`badge ${
                                    r.invoiceStatus === 'Paid'
                                      ? 'badge-Done'
                                      : r.invoiceStatus === 'PartiallyPaid'
                                      ? 'badge-PendingInsurance'
                                      : 'badge-Draft'
                                  }`}
                                >
                                  {r.invoiceStatus}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ==========================================================================
            CONFIGURATION SECTION 1A: USER GROUPS (Owns Permissions — 3NF RBAC)
           ========================================================================== */}
        {activeTab === 'groups' && (
          <div className="o-form-sheet">
            {groupViewMode === 'list' && (
              <div className="erp-sheet-pad">
                <div className="queue-header" style={{ marginBottom: '12px' }}>
                  <div>
                    <h3>User Groups &amp; Permissions Directory</h3>
                    <p className="muted">
                      Module permissions live exclusively on User Groups (3NF). Click any group row
                      to edit its permissions and view all operators assigned to that group.
                    </p>
                  </div>
                  <button type="button" className="btn-secondary" onClick={fetchAdminUsers}>
                    Refresh Groups
                  </button>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID / Code</th>
                      <th>User Group Name &amp; Description</th>
                      <th>Group Module Permissions</th>
                      <th>Assigned Users</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userGroups
                      .filter(g => {
                        const q = configSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          g.groupCode.toLowerCase().includes(q) ||
                          g.groupName.toLowerCase().includes(q) ||
                          (g.description || '').toLowerCase().includes(q)
                        );
                      })
                      .map(g => (
                        <tr
                          key={g.groupId}
                          className="clickable-row"
                          onClick={() => openUserGroupRecord(g.groupId)}
                        >
                          <td>
                            <strong>#{g.groupId}</strong> • <code>{g.groupCode}</code>
                          </td>
                          <td>
                            <strong>{g.groupName}</strong>
                            <br />
                            <small className="muted">{g.description || '—'}</small>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                              {g.canDispatch && <span className="badge badge-Done">Dispatch</span>}
                              {g.canManageFleet && <span className="badge badge-Done">Fleet</span>}
                              {g.canManagePolicies && <span className="badge badge-Done">Policies</span>}
                              {g.canManageBilling && <span className="badge badge-Done">Billing</span>}
                              {g.canManageUsers && <span className="badge badge-Approved">Users &amp; Groups</span>}
                              {!g.canDispatch &&
                                !g.canManageFleet &&
                                !g.canManagePolicies &&
                                !g.canManageBilling &&
                                !g.canManageUsers && <span className="muted">Read-Only</span>}
                            </div>
                          </td>
                          <td>
                            <span className="badge badge-InProgress">
                              {g.memberCount} {g.memberCount === 1 ? 'User' : 'Users'}
                            </span>
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            <div className="action-btn-group">
                              <button
                                type="button"
                                className="btn-xs"
                                onClick={() => openUserGroupRecord(g.groupId)}
                              >
                                Open Group Sheet
                              </button>
                              {!g.isSystemBuiltIn && g.memberCount === 0 && (
                                <button
                                  type="button"
                                  className="btn-xs btn-reject"
                                  onClick={() => handleDeleteUserGroup(g)}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {groupViewMode === 'form' && editingGroup && (() => {
              const groupMembers = adminUsers.filter(
                u => Number(u.groupId) === Number(editingGroup.groupId)
              );
              return (
                <>
                  <div className="o-form-statusbar">
                    <div className="action-btn-group">
                      <button
                        type="button"
                        className="btn-erp-secondary"
                        onClick={() => setGroupViewMode('list')}
                      >
                        ← Back to User Groups List
                      </button>
                      {!editingGroup.isSystemBuiltIn && groupMembers.length === 0 && (
                        <button
                          type="button"
                          className="btn-xs btn-reject"
                          onClick={() => handleDeleteUserGroup(editingGroup)}
                        >
                          Delete Custom Group
                        </button>
                      )}
                    </div>
                    <div className="o-statusbar-status">
                      <span className="o-stage-pill current">
                        {editingGroup.isSystemBuiltIn ? 'Core System Group' : 'Custom User Group'}
                      </span>
                    </div>
                  </div>

                  <div className="erp-sheet-pad">
                    <div className="erp-oe-title">
                      <span className="erp-oe-label">
                        User Group #{editingGroup.groupId} ({editingGroup.groupCode})
                      </span>
                      <h1>{editingGroup.groupName}</h1>
                    </div>

                    <form onSubmit={handleUpdateUserGroup}>
                      <div className="erp-group-grid">
                        <div className="erp-group-col">
                          <div className="erp-group-header">GROUP IDENTITY</div>
                          <div className="form-row">
                            <label>Group Name &amp; Code</label>
                            <div className="split-inputs">
                              <input
                                type="text"
                                value={editingGroup.groupName}
                                onChange={e =>
                                  setEditingGroup({ ...editingGroup, groupName: e.target.value })
                                }
                                required
                              />
                              <input
                                type="text"
                                value={editingGroup.groupCode}
                                disabled={Boolean(editingGroup.isSystemBuiltIn)}
                                onChange={e =>
                                  setEditingGroup({ ...editingGroup, groupCode: e.target.value })
                                }
                                required
                              />
                            </div>
                          </div>
                          <div className="form-row" style={{ marginTop: '8px' }}>
                            <label>Description</label>
                            <input
                              type="text"
                              value={editingGroup.description || ''}
                              onChange={e =>
                                setEditingGroup({ ...editingGroup, description: e.target.value })
                              }
                            />
                          </div>
                        </div>

                        <div className="erp-group-col">
                          <div className="erp-group-header">GROUP PERMISSIONS (INHERITED BY MEMBERS)</div>
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))',
                              gap: '10px',
                              marginTop: '6px'
                            }}
                          >
                            <label className="erp-toggle-switch">
                              <input
                                type="checkbox"
                                checked={Boolean(editingGroup.canDispatch)}
                                onChange={e =>
                                  setEditingGroup({
                                    ...editingGroup,
                                    canDispatch: e.target.checked
                                  })
                                }
                              />
                              <span>Can Dispatch Tows</span>
                            </label>
                            <label className="erp-toggle-switch">
                              <input
                                type="checkbox"
                                checked={Boolean(editingGroup.canManageFleet)}
                                onChange={e =>
                                  setEditingGroup({
                                    ...editingGroup,
                                    canManageFleet: e.target.checked
                                  })
                                }
                              />
                              <span>Manage Trucks &amp; Drivers</span>
                            </label>
                            <label className="erp-toggle-switch">
                              <input
                                type="checkbox"
                                checked={Boolean(editingGroup.canManagePolicies)}
                                onChange={e =>
                                  setEditingGroup({
                                    ...editingGroup,
                                    canManagePolicies: e.target.checked
                                  })
                                }
                              />
                              <span>Manage Policies &amp; Quotas</span>
                            </label>
                            <label className="erp-toggle-switch">
                              <input
                                type="checkbox"
                                checked={Boolean(editingGroup.canManageBilling)}
                                onChange={e =>
                                  setEditingGroup({
                                    ...editingGroup,
                                    canManageBilling: e.target.checked
                                  })
                                }
                              />
                              <span>Manage Billing &amp; Tariffs</span>
                            </label>
                            <label className="erp-toggle-switch">
                              <input
                                type="checkbox"
                                checked={Boolean(editingGroup.canManageUsers)}
                                onChange={e =>
                                  setEditingGroup({
                                    ...editingGroup,
                                    canManageUsers: e.target.checked
                                  })
                                }
                              />
                              <span>Manage Users &amp; Groups</span>
                            </label>
                          </div>

                          <div style={{ marginTop: '16px' }}>
                            <button type="submit" className="btn-primary">
                              Save Group Permissions
                            </button>
                          </div>
                        </div>
                      </div>
                    </form>

                    <div className="erp-notebook">
                      <div className="erp-notebook-tabs">
                        <button type="button" className="erp-nb-tab active">
                          Assigned Users in {editingGroup.groupName} ({groupMembers.length})
                        </button>
                      </div>
                      <div className="erp-notebook-page">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>User ID / Username</th>
                              <th>Full Name</th>
                              <th>Title &amp; Department</th>
                              <th>Station</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {groupMembers.map(u => (
                              <tr
                                key={u.userId}
                                className="clickable-row"
                                onClick={() => openUserRecord(u.userId)}
                              >
                                <td>
                                  <span className="rel-entity-link">@{u.username}</span>
                                </td>
                                <td>
                                  <strong>{u.fullName}</strong>
                                </td>
                                <td>
                                  {u.roleTitle} ({u.department})
                                </td>
                                <td>
                                  <code>{u.stationCode}</code>
                                </td>
                                <td>
                                  {u.isActive ? (
                                    <span className="badge badge-Done">Active</span>
                                  ) : (
                                    <span className="badge badge-Rejected">Deactivated</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {renderInlineRecordChatter(editingGroup.groupCode)}
                    </div>
                  </div>
                </>
              );
            })()}

            {groupViewMode === 'new' && (
              <>
                <div className="o-form-statusbar">
                  <button
                    type="button"
                    className="btn-erp-secondary"
                    onClick={() => setGroupViewMode('list')}
                  >
                    ← Discard / Back to User Groups List
                  </button>
                  <div className="o-statusbar-status">
                    <span className="o-stage-pill current">Create New User Group</span>
                  </div>
                </div>

                <form onSubmit={handleCreateUserGroup} className="erp-sheet-pad">
                  <div className="erp-oe-title">
                    <span className="erp-oe-label">New Permission Group</span>
                    <h1>{newGroupForm.groupName || newGroupForm.groupCode}</h1>
                  </div>
                  <div className="erp-group-grid">
                    <div className="erp-group-col">
                      <div className="erp-group-header">GROUP IDENTITY</div>
                      <div className="form-row">
                        <label>Group Code (Unique)</label>
                        <input
                          type="text"
                          value={newGroupForm.groupCode}
                          onChange={e =>
                            setNewGroupForm({ ...newGroupForm, groupCode: e.target.value })
                          }
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Group Name</label>
                        <input
                          type="text"
                          value={newGroupForm.groupName}
                          onChange={e =>
                            setNewGroupForm({ ...newGroupForm, groupName: e.target.value })
                          }
                          required
                        />
                      </div>
                      <div className="form-row" style={{ marginTop: '8px' }}>
                        <label>Description</label>
                        <input
                          type="text"
                          value={newGroupForm.description}
                          onChange={e =>
                            setNewGroupForm({ ...newGroupForm, description: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <div className="erp-group-col">
                      <div className="erp-group-header">ASSIGNED MODULE PERMISSIONS</div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))',
                          gap: '10px',
                          marginTop: '6px'
                        }}
                      >
                        <label className="erp-toggle-switch">
                          <input
                            type="checkbox"
                            checked={newGroupForm.canDispatch}
                            onChange={e =>
                              setNewGroupForm({ ...newGroupForm, canDispatch: e.target.checked })
                            }
                          />
                          <span>Can Dispatch Tows</span>
                        </label>
                        <label className="erp-toggle-switch">
                          <input
                            type="checkbox"
                            checked={newGroupForm.canManageFleet}
                            onChange={e =>
                              setNewGroupForm({
                                ...newGroupForm,
                                canManageFleet: e.target.checked
                              })
                            }
                          />
                          <span>Manage Trucks &amp; Drivers</span>
                        </label>
                        <label className="erp-toggle-switch">
                          <input
                            type="checkbox"
                            checked={newGroupForm.canManagePolicies}
                            onChange={e =>
                              setNewGroupForm({
                                ...newGroupForm,
                                canManagePolicies: e.target.checked
                              })
                            }
                          />
                          <span>Manage Policies &amp; Quotas</span>
                        </label>
                        <label className="erp-toggle-switch">
                          <input
                            type="checkbox"
                            checked={newGroupForm.canManageBilling}
                            onChange={e =>
                              setNewGroupForm({
                                ...newGroupForm,
                                canManageBilling: e.target.checked
                              })
                            }
                          />
                          <span>Manage Billing &amp; Tariffs</span>
                        </label>
                        <label className="erp-toggle-switch">
                          <input
                            type="checkbox"
                            checked={newGroupForm.canManageUsers}
                            onChange={e =>
                              setNewGroupForm({
                                ...newGroupForm,
                                canManageUsers: e.target.checked
                              })
                            }
                          />
                          <span>Manage Users &amp; Groups</span>
                        </label>
                      </div>
                    </div>
                  </div>
                  <button type="submit" className="btn-erp-primary">
                    Save &amp; Create User Group
                  </button>
                </form>
              </>
            )}
          </div>
        )}

        {/* ==========================================================================
            CONFIGURATION SECTION 1B: USERS (Assigned to UserGroup -> Inherits Perms)
           ========================================================================== */}
        {activeTab === 'users' && (
          <div className="o-form-sheet">
            {userViewMode === 'list' && (
              <div className="erp-sheet-pad">
                <div className="queue-header" style={{ marginBottom: '12px' }}>
                  <div>
                    <h3>System Operators Directory</h3>
                    <p className="muted">
                      Each operator is assigned to a normalized <strong>User Group</strong> (e.g.{' '}
                      <code>assaad.khalife</code> → <em>System Administrators</em>), inheriting all
                      permissions from that group. Click any row to inspect or edit the user.
                    </p>
                  </div>
                  <button type="button" className="btn-secondary" onClick={fetchAdminUsers}>
                    {adminLoading ? 'Refreshing...' : 'Refresh Users'}
                  </button>
                </div>

                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ID / Username</th>
                      <th>Full Name &amp; Title</th>
                      <th>Station</th>
                      <th>Assigned User Group</th>
                      <th>Inherited Group Permissions</th>
                      <th>Status</th>
                      <th>Related History</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminUsers
                      .filter(u => {
                        const q = configSearch.trim().toLowerCase();
                        if (!q) return true;
                        return (
                          u.username.toLowerCase().includes(q) ||
                          u.fullName.toLowerCase().includes(q) ||
                          (u.groupName || u.accessRole || '').toLowerCase().includes(q) ||
                          u.stationCode.toLowerCase().includes(q)
                        );
                      })
                      .map(u => (
                        <tr
                          key={u.userId}
                          className="clickable-row"
                          onClick={() => openUserRecord(u.userId)}
                        >
                          <td>
                            <strong>#{u.userId}</strong> • <code>{u.username}</code>
                          </td>
                          <td>
                            <strong>{u.fullName}</strong>
                            <br />
                            <small className="muted">
                              {u.roleTitle} ({u.department})
                            </small>
                          </td>
                          <td>
                            <code>{u.stationCode}</code>
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              className="rel-entity-link"
                              onClick={() => openUserGroupRecord(u.groupId)}
                            >
                              {u.groupName || u.accessRole}
                            </button>
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                              {u.canDispatch && <span className="badge badge-Done">Dispatch</span>}
                              {u.canManageFleet && <span className="badge badge-Done">Fleet</span>}
                              {u.canManagePolicies && <span className="badge badge-Done">Policies</span>}
                              {u.canManageBilling && <span className="badge badge-Done">Billing</span>}
                              {u.canManageUsers && <span className="badge badge-Approved">Users &amp; Groups</span>}
                            </div>
                          </td>
                          <td>
                            {u.isActive ? (
                              <span className="badge badge-Done">Active</span>
                            ) : (
                              <span className="badge badge-Rejected">Deactivated</span>
                            )}
                          </td>
                          <td>
                            {u.createdTowCount} tows • {u.auditActionCount} audits
                          </td>
                          <td onClick={e => e.stopPropagation()}>
                            <div className="action-btn-group">
                              <button
                                type="button"
                                className="btn-xs"
                                onClick={() => openUserRecord(u.userId)}
                              >
                                Open User Sheet
                              </button>
                              {u.userId !== currentUser.userId && (
                                <button
                                  type="button"
                                  className="btn-xs btn-reject"
                                  onClick={() => handleAdminDeleteUser(u)}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {userViewMode === 'form' && editingUser && (() => {
              const selectedGroupObj =
                userGroups.find(g => Number(g.groupId) === Number(editingUser.groupId)) || null;
              const userTows = (dashboard?.recentRequests || []).filter(
                r =>
                  r.createdByUserId === editingUser.userId ||
                  (r.createdByUsername || '').toLowerCase() === editingUser.username.toLowerCase()
              );
              const userPayments = (dashboard?.invoicePayments || []).filter(
                pm =>
                  pm.recordedByUserId === editingUser.userId ||
                  (pm.recordedByUsername || '').toLowerCase() === editingUser.username.toLowerCase()
              );
              const userAudits = (dashboard?.auditLogs || []).filter(
                a => a.dispatcherUserId === editingUser.userId
              );
              return (
                <>
                  <div className="o-form-statusbar">
                    <div className="action-btn-group">
                      <button
                        type="button"
                        className="btn-erp-secondary"
                        onClick={() => setUserViewMode('list')}
                      >
                        ← Back to Users List
                      </button>
                      {editingUser.userId !== currentUser.userId && (
                        <button
                          type="button"
                          className="btn-xs btn-reject"
                          onClick={() => handleAdminDeleteUser(editingUser)}
                        >
                          Delete / Deactivate Operator
                        </button>
                      )}
                    </div>
                    <div className="o-statusbar-status">
                      <span className="o-stage-pill current">
                        {editingUser.isActive
                          ? `Active • ${selectedGroupObj?.groupName || editingUser.groupName}`
                          : 'Deactivated'}
                      </span>
                    </div>
                  </div>

                  <div className="erp-sheet-pad">
                    <div className="erp-oe-title">
                      <span className="erp-oe-label">
                        Operator #{editingUser.userId} (@{editingUser.username})
                      </span>
                      <h1>{editingUser.fullName}</h1>
                    </div>

                    <form onSubmit={handleAdminUpdateUser}>
                      <div className="erp-group-grid">
                        <div className="erp-group-col">
                          <div className="erp-group-header">OPERATOR PROFILE &amp; GROUP ASSIGNMENT</div>
                          <div className="form-row">
                            <label>Full Name &amp; Station Code</label>
                            <div className="split-inputs">
                              <input
                                type="text"
                                value={editingUser.fullName}
                                onChange={e =>
                                  setEditingUser({ ...editingUser, fullName: e.target.value })
                                }
                                required
                              />
                              <input
                                type="text"
                                value={editingUser.stationCode}
                                onChange={e =>
                                  setEditingUser({ ...editingUser, stationCode: e.target.value })
                                }
                                required
                              />
                            </div>
                          </div>

                          <div className="form-row" style={{ marginTop: '8px' }}>
                            <label>Assigned User Group (Determines Permissions)</label>
                            <select
                              value={editingUser.groupId}
                              onChange={e =>
                                setEditingUser({
                                  ...editingUser,
                                  groupId: Number(e.target.value)
                                })
                              }
                            >
                              {userGroups.map(g => (
                                <option key={g.groupId} value={g.groupId}>
                                  {g.groupName} ({g.groupCode})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="form-row" style={{ marginTop: '8px' }}>
                            <label>Role Title &amp; Department</label>
                            <div className="split-inputs">
                              <input
                                type="text"
                                value={editingUser.roleTitle}
                                onChange={e =>
                                  setEditingUser({ ...editingUser, roleTitle: e.target.value })
                                }
                                required
                              />
                              <input
                                type="text"
                                value={editingUser.department}
                                onChange={e =>
                                  setEditingUser({ ...editingUser, department: e.target.value })
                                }
                                required
                              />
                            </div>
                          </div>

                          <div className="form-row" style={{ marginTop: '8px' }}>
                            <label>Reset Password (Optional — BCrypt Cost=12)</label>
                            <input
                              type="password"
                              placeholder="Leave blank to keep existing BCrypt hash..."
                              value={editingUser.newPassword || ''}
                              onChange={e =>
                                setEditingUser({ ...editingUser, newPassword: e.target.value })
                              }
                            />
                          </div>

                          <div className="form-row" style={{ marginTop: '10px' }}>
                            <label className="erp-toggle-switch">
                              <input
                                type="checkbox"
                                checked={Boolean(editingUser.isActive)}
                                onChange={e =>
                                  setEditingUser({ ...editingUser, isActive: e.target.checked })
                                }
                              />
                              <span>Account Login Active</span>
                            </label>
                          </div>

                          <div style={{ marginTop: '14px' }}>
                            <button type="submit" className="btn-primary">
                              Save Operator &amp; Group Assignment
                            </button>
                          </div>
                        </div>

                        <div className="erp-group-col">
                          <div className="erp-group-header">INHERITED PERMISSIONS FROM USER GROUP</div>
                          <div className="erp-field-row">
                            <label>Assigned User Group</label>
                            <div className="erp-field-val">
                              {selectedGroupObj ? (
                                <button
                                  type="button"
                                  className="rel-entity-link"
                                  onClick={() => openUserGroupRecord(selectedGroupObj.groupId)}
                                >
                                  {selectedGroupObj.groupName} ({selectedGroupObj.groupCode}) →
                                </button>
                              ) : (
                                <span>{editingUser.groupName}</span>
                              )}
                            </div>
                          </div>
                          <div className="erp-field-row">
                            <label>Group Description</label>
                            <div className="erp-field-val">
                              <span className="muted">
                                {selectedGroupObj?.description || 'Inherited via foreign key GroupId'}
                              </span>
                            </div>
                          </div>
                          <div className="erp-field-row">
                            <label>Effective Permissions</label>
                            <div className="erp-field-val">
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                {(selectedGroupObj?.canDispatch ?? editingUser.canDispatch) && (
                                  <span className="badge badge-Done">Can Dispatch Tows</span>
                                )}
                                {(selectedGroupObj?.canManageFleet ?? editingUser.canManageFleet) && (
                                  <span className="badge badge-Done">Manage Trucks &amp; Drivers</span>
                                )}
                                {(selectedGroupObj?.canManagePolicies ?? editingUser.canManagePolicies) && (
                                  <span className="badge badge-Done">Manage Policies &amp; Quotas</span>
                                )}
                                {(selectedGroupObj?.canManageBilling ?? editingUser.canManageBilling) && (
                                  <span className="badge badge-Done">Manage Billing &amp; Tariffs</span>
                                )}
                                {(selectedGroupObj?.canManageUsers ?? editingUser.canManageUsers) && (
                                  <span className="badge badge-Approved">Manage Users &amp; Groups</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </form>

                    <div className="erp-notebook">
                      <div className="erp-notebook-tabs">
                        <button
                          type="button"
                          className={userNotebookTab === 'tows' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                          onClick={() => setUserNotebookTab('tows')}
                        >
                          Created / Dispatched Tow Requests ({userTows.length})
                        </button>
                        <button
                          type="button"
                          className={userNotebookTab === 'payments' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                          onClick={() => setUserNotebookTab('payments')}
                        >
                          Recorded Invoice Payments ({userPayments.length})
                        </button>
                        <button
                          type="button"
                          className={userNotebookTab === 'audits' ? 'erp-nb-tab active' : 'erp-nb-tab'}
                          onClick={() => setUserNotebookTab('audits')}
                        >
                          Lifecycle Audit Actions ({userAudits.length})
                        </button>
                      </div>

                      <div className="erp-notebook-page">
                        {userNotebookTab === 'tows' && (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Request #</th>
                                <th>Customer &amp; Vehicle</th>
                                <th>Issue Type</th>
                                <th>Road Distance</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {userTows.map(r => (
                                <tr
                                  key={r.towRequestId}
                                  className="clickable-row"
                                  onClick={() => openTowRequestRecord(r.towRequestId)}
                                >
                                  <td>
                                    <strong>{r.requestNumber}</strong>
                                  </td>
                                  <td>
                                    {r.customerName} • <code>{r.vehiclePlate}</code>
                                  </td>
                                  <td>{r.issueType}</td>
                                  <td>{r.actualDistanceKm} km</td>
                                  <td>
                                    <span className={`badge badge-${r.status}`}>{r.status}</span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {userNotebookTab === 'payments' && (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Payment #</th>
                                <th>Invoice</th>
                                <th>Payer</th>
                                <th>Amount</th>
                                <th>Method &amp; Paid At</th>
                              </tr>
                            </thead>
                            <tbody>
                              {userPayments.map(pm => (
                                <tr
                                  key={pm.paymentId}
                                  className="clickable-row"
                                  onClick={() => openInvoiceRecord(pm.invoiceId)}
                                >
                                  <td>#{pm.paymentId}</td>
                                  <td>
                                    <strong>{pm.invoiceNumber}</strong>
                                  </td>
                                  <td>
                                    {pm.payerName} ({pm.payerType})
                                  </td>
                                  <td>
                                    <strong className="text-green">+${pm.amountPaid}</strong>
                                  </td>
                                  <td>
                                    {pm.paymentMethod} • {pm.paidAt}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}

                        {userNotebookTab === 'audits' && (
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Audit #</th>
                                <th>Request #</th>
                                <th>Transition</th>
                                <th>Action Note</th>
                                <th>Timestamp</th>
                              </tr>
                            </thead>
                            <tbody>
                              {userAudits.map(a => (
                                <tr
                                  key={a.auditId}
                                  className="clickable-row"
                                  onClick={() => openTowRequestRecord(a.towRequestId)}
                                >
                                  <td>#{a.auditId}</td>
                                  <td>
                                    <strong>{a.requestNumber}</strong>
                                  </td>
                                  <td>
                                    <code>{a.oldStatus}</code> →{' '}
                                    <span className={`badge badge-${a.newStatus}`}>{a.newStatus}</span>
                                  </td>
                                  <td>{a.actionNote}</td>
                                  <td>{a.changedAt}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                      {renderInlineRecordChatter(editingUser.username)}
                    </div>
                  </div>
                </>
              );
            })()}

            {userViewMode === 'new' && (() => {
              const previewGroup =
                userGroups.find(g => Number(g.groupId) === Number(newUserForm.groupId)) || null;
              return (
                <>
                  <div className="o-form-statusbar">
                    <button
                      type="button"
                      className="btn-erp-secondary"
                      onClick={() => setUserViewMode('list')}
                    >
                      ← Discard / Back to Users List
                    </button>
                    <div className="o-statusbar-status">
                      <span className="o-stage-pill current">Provision New Operator</span>
                    </div>
                  </div>

                  <form onSubmit={handleAdminCreateUser} className="erp-sheet-pad">
                    <div className="erp-oe-title">
                      <span className="erp-oe-label">New Operator Account</span>
                      <h1>{newUserForm.fullName || newUserForm.username || 'New Operator'}</h1>
                    </div>

                    <div className="erp-group-grid">
                      <div className="erp-group-col">
                        <div className="erp-group-header">LOGIN CREDENTIALS &amp; GROUP ASSIGNMENT</div>
                        <div className="form-row">
                          <label>Username (Unique Login ID)</label>
                          <input
                            type="text"
                            placeholder="e.g. night.dispatcher"
                            value={newUserForm.username}
                            onChange={e =>
                              setNewUserForm({ ...newUserForm, username: e.target.value })
                            }
                            required
                          />
                        </div>
                        <div className="form-row" style={{ marginTop: '8px' }}>
                          <label>Initial Password (BCrypt Cost=12)</label>
                          <input
                            type="password"
                            placeholder="Min 6 characters"
                            value={newUserForm.password}
                            onChange={e =>
                              setNewUserForm({ ...newUserForm, password: e.target.value })
                            }
                            required
                          />
                        </div>
                        <div className="form-row" style={{ marginTop: '8px' }}>
                          <label>Full Name &amp; Station Code</label>
                          <div className="split-inputs">
                            <input
                              type="text"
                              placeholder="e.g. Jad Mansour"
                              value={newUserForm.fullName}
                              onChange={e =>
                                setNewUserForm({ ...newUserForm, fullName: e.target.value })
                              }
                              required
                            />
                            <input
                              type="text"
                              value={newUserForm.stationCode}
                              onChange={e =>
                                setNewUserForm({ ...newUserForm, stationCode: e.target.value })
                              }
                              required
                            />
                          </div>
                        </div>
                        <div className="form-row" style={{ marginTop: '8px' }}>
                          <label>Assigned User Group (Inherits Permissions)</label>
                          <select
                            value={newUserForm.groupId}
                            onChange={e =>
                              setNewUserForm({ ...newUserForm, groupId: Number(e.target.value) })
                            }
                          >
                            {userGroups.map(g => (
                              <option key={g.groupId} value={g.groupId}>
                                {g.groupName} ({g.groupCode})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="form-row" style={{ marginTop: '8px' }}>
                          <label>Role Title &amp; Department</label>
                          <div className="split-inputs">
                            <input
                              type="text"
                              value={newUserForm.roleTitle}
                              onChange={e =>
                                setNewUserForm({ ...newUserForm, roleTitle: e.target.value })
                              }
                              required
                            />
                            <input
                              type="text"
                              value={newUserForm.department}
                              onChange={e =>
                                setNewUserForm({ ...newUserForm, department: e.target.value })
                              }
                              required
                            />
                          </div>
                        </div>
                      </div>

                      <div className="erp-group-col">
                        <div className="erp-group-header">PERMISSIONS INHERITED FROM SELECTED GROUP</div>
                        {previewGroup && (
                          <>
                            <div className="erp-field-row">
                              <label>User Group</label>
                              <div className="erp-field-val">
                                <strong>{previewGroup.groupName}</strong> (<code>{previewGroup.groupCode}</code>)
                              </div>
                            </div>
                            <div className="erp-field-row">
                              <label>Effective Modules</label>
                              <div className="erp-field-val">
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                  {previewGroup.canDispatch && (
                                    <span className="badge badge-Done">Can Dispatch Tows</span>
                                  )}
                                  {previewGroup.canManageFleet && (
                                    <span className="badge badge-Done">Manage Trucks &amp; Drivers</span>
                                  )}
                                  {previewGroup.canManagePolicies && (
                                    <span className="badge badge-Done">Manage Policies &amp; Quotas</span>
                                  )}
                                  {previewGroup.canManageBilling && (
                                    <span className="badge badge-Done">Manage Billing &amp; Tariffs</span>
                                  )}
                                  {previewGroup.canManageUsers && (
                                    <span className="badge badge-Approved">Manage Users &amp; Groups</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    <button type="submit" className="btn-erp-primary">
                      + Create Operator &amp; Assign Group
                    </button>
                  </form>
                </>
              );
            })()}
          </div>
        )}
      </main>

      {/* ============================================================================
          SECTION-SCOPED ODOO-STYLE PLAIN CHATTER / CHANGE LOG PANEL
          Grouped per event (Who, Record, Time + bulleted Field: Old -> New), no cards/badges
         ============================================================================ */}
      {Boolean(CHANGE_LOG_SECTIONS[activeTab]) && (
        <>
          {!changeLogOpen && (
            <button
              type="button"
              className="changelog-edge-tab"
              onClick={() => setChangeLogOpen(true)}
              title={`Open ${CHANGE_LOG_SECTIONS[activeTab]} Change Log`}
            >
              Change Log
            </button>
          )}

          {changeLogOpen &&
            (() => {
              const sectionLabel = CHANGE_LOG_SECTIONS[activeTab];
              const q = changeLogFilter.trim().toLowerCase();
              const filteredEvents = q
                ? changeLogs.filter(ev => {
                    const headerMatch =
                      String(ev.changedByFullName || '').toLowerCase().includes(q) ||
                      String(ev.changedByUsername || '').toLowerCase().includes(q) ||
                      String(ev.entityCode || '').toLowerCase().includes(q) ||
                      String(ev.operationType || '').toLowerCase().includes(q) ||
                      String(ev.changedAt || '').toLowerCase().includes(q);
                    if (headerMatch) return true;
                    return (ev.details || []).some(
                      d =>
                        String(d.fieldName || '').toLowerCase().includes(q) ||
                        String(d.oldValue ?? '').toLowerCase().includes(q) ||
                        String(d.newValue ?? '').toLowerCase().includes(q)
                    );
                  })
                : changeLogs;

              let lastDateGroup = '';

              return (
                <aside
                  className="changelog-side-drawer"
                  aria-label={`${sectionLabel} Change Log`}
                >
                  <div className="o-chatter-topbar">
                    <span className="o-chatter-title">
                      Change Log — {sectionLabel}
                    </span>
                    <div className="o-chatter-actions">
                      <button
                        type="button"
                        className="o-chatter-btn"
                        onClick={() => fetchChangeLogs()}
                      >
                        {changeLogLoading ? '...' : 'Refresh'}
                      </button>
                      <button
                        type="button"
                        className="o-chatter-btn"
                        onClick={() => setChangeLogOpen(false)}
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  <div className="o-chatter-filter-bar">
                    <input
                      type="text"
                      className="o-chatter-filter-input"
                      placeholder={`Filter ${sectionLabel} log...`}
                      value={changeLogFilter}
                      onChange={e => setChangeLogFilter(e.target.value)}
                    />
                  </div>

                  <div className="o-chatter-stream">
                    {filteredEvents.length === 0 ? (
                      <p className="o-chatter-note" style={{ textAlign: 'center', marginTop: '20px' }}>
                        {changeLogLoading
                          ? 'Loading...'
                          : `No changes logged yet for ${sectionLabel}.`}
                      </p>
                    ) : (
                      filteredEvents.map(ev => {
                        const rawStamp = String(ev.changedAt || '');
                        const datePart = rawStamp.length >= 10 ? rawStamp.slice(0, 10) : 'Recent';
                        const timePart = rawStamp.length >= 19 ? rawStamp.slice(11, 19) : rawStamp;
                        const showDateSep = datePart !== lastDateGroup;
                        lastDateGroup = datePart;

                        const op = String(ev.operationType || 'UPDATE').toUpperCase();
                        const details = ev.details || [];

                        return (
                          <React.Fragment key={ev.changeEventId}>
                            {showDateSep && (
                              <div className="o-chatter-date-sep">{datePart}</div>
                            )}
                            <div className="o-chatter-message">
                              <div className="o-chatter-msg-head">
                                <div>
                                  <span className="o-chatter-author">
                                    {ev.changedByFullName || ev.changedByUsername || 'System'}
                                  </span>{' '}
                                  <span className="o-chatter-record-ref">
                                    ({ev.changedByUsername || 'system'}) · {ev.entityCode || `#${ev.entityId}`}
                                  </span>
                                </div>
                                <span className="o-chatter-time">{timePart}</span>
                              </div>

                              {op === 'CREATE' && (
                                <div className="o-chatter-note">Record created</div>
                              )}
                              {op === 'DELETE' && (
                                <div className="o-chatter-note">Record deleted</div>
                              )}

                              {details.length > 0 && (
                                <ul className="o-chatter-tracking-list">
                                  {details.map(d => {
                                    const oldText =
                                      d.oldValue !== null && d.oldValue !== undefined && d.oldValue !== ''
                                        ? String(d.oldValue)
                                        : 'None';
                                    const newText =
                                      d.newValue !== null && d.newValue !== undefined && d.newValue !== ''
                                        ? String(d.newValue)
                                        : 'None';

                                    if (op === 'CREATE') {
                                      return (
                                        <li key={d.changeDetailId}>
                                          <span className="o-chatter-field">{d.fieldName}:</span>{' '}
                                          <span className="o-chatter-new">{newText}</span>
                                        </li>
                                      );
                                    }
                                    if (op === 'DELETE') {
                                      return (
                                        <li key={d.changeDetailId}>
                                          <span className="o-chatter-field">{d.fieldName}:</span>{' '}
                                          <span className="o-chatter-old">{oldText}</span>
                                        </li>
                                      );
                                    }
                                    return (
                                      <li key={d.changeDetailId}>
                                        <span className="o-chatter-field">{d.fieldName}:</span>{' '}
                                        <span className="o-chatter-old">{oldText}</span>
                                        <span className="o-chatter-arrow">→</span>
                                        <span className="o-chatter-new">{newText}</span>
                                      </li>
                                    );
                                  })}
                                </ul>
                              )}
                            </div>
                          </React.Fragment>
                        );
                      })
                    )}
                  </div>
                </aside>
              );
            })()}
        </>
      )}
    </div>
  );
}
