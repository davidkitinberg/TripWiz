/**
 * @fileoverview Trip overview hub: logistics sections, attachments, weather, and export.
 * @authors David Kitinberg, Amit Bitton, Sagi Hassid
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../services/api';
import {
  ArrowLeft,
  BedDouble,
  Calendar,
  Check,
  ChevronRight,
  CarFront,
  ClipboardList,
  Download,
  ExternalLink,
  Home,
  Loader2,
  MapPin,
  MoreHorizontal,
  Package,
  Pencil,
  Plane,
  Paperclip,
  FileText,
  Plus,
  Save,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import airports from '../data/airports.json';

const SECTION_ORDER = [
  { id: 'overview', label: 'Reservations', icon: ClipboardList },
  { id: 'flights', label: 'Flights', icon: Plane },
  { id: 'accommodation', label: 'Accommodation', icon: BedDouble },
  { id: 'rental-car', label: 'Rental Car', icon: CarFront },
  { id: 'documents', label: 'Trip Documents', icon: Paperclip },
  { id: 'itinerary', label: 'Itinerary', icon: MapPin },
  { id: 'notes', label: 'Notes', icon: FileText },
  { id: 'packing', label: 'Packing List', icon: Package },
  { id: 'export', label: 'Export', icon: Download },
];

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STAY_KEYWORDS = [
  'hotel',
  'hostel',
  'apartment',
  'airbnb',
  'accommodation',
  'lodging',
  'stay',
  'cabin',
  'resort',
  'motel',
  'guest house',
  'guesthouse',
  'villa',
  'inn',
  'bnb',
  'check in',
  'check out',
];
const ACCOMMODATION_TYPE_OPTIONS = [
  { value: 'Hotel', aliases: ['hotel'] },
  { value: 'Apartment', aliases: ['apartment'] },
  { value: 'Cabin', aliases: ['cabin'] },
  { value: 'Villa', aliases: ['villa'] },
  { value: 'Hostel', aliases: ['hostel'] },
  { value: 'Guesthouse', aliases: ['guesthouse', 'guest house'] },
  { value: 'Resort', aliases: ['resort'] },
  { value: 'Airbnb / Vacation rental', aliases: ['airbnb', 'vacation rental', 'airbnb / vacation rental'] },
  { value: 'Zimmer / B&B', aliases: ['zimmer', 'b&b', 'bnb', 'zimmer / b&b'] },
  { value: 'Other', aliases: ['other'] },
];

const DEFAULT_PACKING = [
  { id: uid('cat'), name: 'Clothes', items: [] },
  { id: uid('cat'), name: 'Toiletries', items: [] },
  { id: uid('cat'), name: 'Documents', items: [] },
  { id: uid('cat'), name: 'Electronics', items: [] },
  { id: uid('cat'), name: 'Medicines', items: [] },
  { id: uid('cat'), name: 'Other', items: [] },
];

function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

function loadLocalImages() {
  try {
    return JSON.parse(localStorage.getItem('tripwiz_images') || '{}');
  } catch {
    return {};
  }
}

// [Feature #39] Fetch destination hero imagery from Wikipedia
async function fetchWikiThumbnail(query) {
  if (!query) return null;
  const params = new URLSearchParams({
    action: 'query',
    titles: query,
    prop: 'pageimages',
    format: 'json',
    pithumbsize: '1280',
    origin: '*',
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  return page?.thumbnail?.source || null;
}

function buildHeroSearchTerms(trip, dashboard) {
  const terms = [];
  const title = String(trip?.title || '').trim();
  const cleaned = title
    .replace(/^trip to\s+/i, '')
    .replace(/^trip\s*:\s*/i, '')
    .replace(/^my\s+/i, '')
    .trim();
  if (cleaned) terms.push(cleaned);
  if (title && title !== cleaned) terms.push(title);
  if (trip?.startDate && trip?.endDate) terms.push(`${cleaned || title} travel`);
  (trip?.itinerary || [])
    .slice(0, 4)
    .map((stop) => stop.title || stop.name || '')
    .filter(Boolean)
    .forEach((term) => terms.push(term));
  if (dashboard?.coverImageUrl) terms.unshift('__custom__');
  return [...new Set(terms.filter(Boolean))];
}

function isExplicitField(source, field) {
  return !!source && Object.prototype.hasOwnProperty.call(source, field);
}

function parseTripDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatIsoDate(value) {
  const date = parseTripDate(value);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(value) {
  const date = parseTripDate(value);
  if (!value) return '';
  if (!date) return String(value);
  return `${date.getDate()} ${MONTH_LABELS[date.getMonth()]} ${date.getFullYear()}`;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isNaN(date.getTime()) && String(value).includes('T')) {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return String(value).slice(0, 5);
}

function formatDateRange(start, end) {
  if (!start) return 'Dates not set';
  const startLabel = formatDisplayDate(start);
  const endLabel = end ? formatDisplayDate(end) : '';
  return endLabel ? `${startLabel} - ${endLabel}` : startLabel;
}

function formatPdfDate(value) {
  return formatDisplayDate(value);
}

function classifyAccommodation(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('apartment')) return 'Apartment';
  if (lower.includes('cabin')) return 'Cabin';
  if (lower.includes('resort')) return 'Resort';
  if (lower.includes('hostel')) return 'Hostel';
  if (lower.includes('motel')) return 'Motel';
  if (lower.includes('guest house') || lower.includes('guesthouse')) return 'Guest house';
  if (lower.includes('villa')) return 'Villa';
  if (lower.includes('bnb') || lower.includes('airbnb')) return 'Airbnb';
  return 'Hotel';
}

function findAccommodationTypeOption(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return ACCOMMODATION_TYPE_OPTIONS[0];
  return ACCOMMODATION_TYPE_OPTIONS.find((option) => (
    option.value.toLowerCase() === normalized || option.aliases.includes(normalized)
  )) || null;
}

function formatAccommodationType(value) {
  const option = findAccommodationTypeOption(value);
  return option ? option.value : String(value || 'Hotel').trim();
}

function looksLikeAccommodation(stop) {
  const text = [stop?.title, stop?.name, stop?.notes, stop?.category, stop?.type].filter(Boolean).join(' ').toLowerCase();
  return STAY_KEYWORDS.some((keyword) => text.includes(keyword));
}

function deriveAccommodationFromStop(stop, trip) {
  if (!looksLikeAccommodation(stop)) return null;
  const baseDate = parseTripDate(trip?.startDate);
  const dayIndex = Number.isInteger(stop?.dayIndex) ? stop.dayIndex : 0;
  const checkInDate = baseDate ? new Date(baseDate) : null;
  if (checkInDate) checkInDate.setDate(checkInDate.getDate() + dayIndex);
  const checkOutDate = checkInDate ? new Date(checkInDate) : null;
  if (checkOutDate) checkOutDate.setDate(checkOutDate.getDate() + 1);
  return {
    id: stop.slotId || stop.id || uid('stay'),
    name: stop.title || stop.name || 'Accommodation',
    type: classifyAccommodation([stop.title, stop.name, stop.notes, stop.category, stop.type].filter(Boolean).join(' ')).toLowerCase(),
    checkIn: formatIsoDate(checkInDate),
    checkOut: formatIsoDate(checkOutDate),
    address: stop.address || stop.location || '',
    notes: stop.notes && !/^\d+(?:–|-)\d+$/.test(String(stop.notes)) ? String(stop.notes) : '',
    source: 'itinerary',
  };
}

// [Feature #33] Auto-derive likely accommodations from hotel-like itinerary stops
function deriveAccommodationsFromItinerary(itinerary = [], trip = null) {
  return itinerary
    .map((stop) => deriveAccommodationFromStop(stop, trip))
    .filter(Boolean);
}

// Trip date range as ISO "YYYY-MM-DD" strings, for <input type="date" min/max> and range checks.
// A trip with no end date is treated as a single-day trip (end === start).
function tripDateBounds(trip) {
  const min = formatIsoDate(trip?.startDate);
  const max = formatIsoDate(trip?.endDate) || min;
  return { min: min || '', max: max || '' };
}

// A flight date is valid when it's left blank (not yet chosen) or falls within the trip's dates.
function isFlightDateWithinTrip(dateValue, trip) {
  if (!dateValue) return true;
  const { min, max } = tripDateBounds(trip);
  if (!min) return true;
  return dateValue >= min && dateValue <= max;
}

const FLIGHT_STOP_PREFIX = 'flight-';

// [Feature #32] Mirror a saved flight onto the trip-plan map as an itinerary stop, placed on
// the day it lands (or departs, if no arrival time is known) at the corresponding time —
// so flights show up alongside the rest of the day's plan without manual re-entry.
function deriveItineraryStopFromFlight(flight, trip) {
  if (!flight?.id || !flight?.date) return null;
  const tripStart = parseTripDate(trip?.startDate);
  const flightDate = parseTripDate(flight.date);
  if (!tripStart || !flightDate) return null;

  const dayIndex = Math.round((flightDate - tripStart) / (1000 * 60 * 60 * 24));
  if (dayIndex < 0) return null;

  const coords = airportCoordsByIata(flight.toIata) || airportCoordsByIata(flight.fromIata);
  if (!coords) return null;

  const time = flight.arrivalTime || flight.departureTime || '00:00';
  const start = `${formatIsoDate(flightDate)}T${time}:00.000Z`;
  const fromLabel = flight.from || flight.fromAirport || 'Departure';
  const toLabel = flight.to || flight.toAirport || 'Arrival';
  const flightCode = [flight.airline, flight.flightNumber].filter(Boolean).join(' ');

  return {
    slotId: `${FLIGHT_STOP_PREFIX}${flight.id}`,
    title: `Flight${flightCode ? ` ${flightCode}` : ''}: ${fromLabel} → ${toLabel}`,
    start,
    coords,
    dayIndex,
    notes: flight.notes || '',
  };
}

// Keeps the itinerary's flight-derived stop in sync with a saved flight: replaces (or removes,
// if the flight can no longer be placed — e.g. no airport coordinates yet) the stop tied to
// this flight's id, leaving every other stop untouched.
function applyFlightToItinerary(itinerary, flight, trip) {
  const stopId = `${FLIGHT_STOP_PREFIX}${flight.id}`;
  const withoutFlightStop = (itinerary || []).filter((stop) => stop.slotId !== stopId);
  const stop = deriveItineraryStopFromFlight(flight, trip);
  return stop ? [...withoutFlightStop, stop] : withoutFlightStop;
}

function removeFlightFromItinerary(itinerary, flightId) {
  const stopId = `${FLIGHT_STOP_PREFIX}${flightId}`;
  return (itinerary || []).filter((stop) => stop.slotId !== stopId);
}

function normalizePackingCategories(input) {
  const categories = Array.isArray(input) ? input : [];
  if (categories.length === 0) return DEFAULT_PACKING.map((c) => ({ ...c, items: [] }));
  return categories.map((category) => ({
    id: category.id || uid('cat'),
    name: category.name || 'Category',
    items: Array.isArray(category.items)
      ? category.items.map((item) => ({
          id: item.id || uid('item'),
          label: item.label || '',
          checked: !!item.checked,
        }))
      : [],
  }));
}

function normalizeDashboard(metadata, trip = null) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const derivedAccommodations = trip ? deriveAccommodationsFromItinerary(trip.itinerary || [], trip) : [];
  const hasExplicitAccommodations = isExplicitField(source, 'accommodations');
  const rentalCars = Array.isArray(source.rentalCars)
    ? source.rentalCars.map((car) => ({
        id: car.id || uid('rental-car'),
        company: car.company || '',
        pickupLocation: car.pickupLocation || '',
        pickupDate: car.pickupDate || '',
        pickupTime: car.pickupTime || '',
        returnLocation: car.returnLocation || '',
        returnDate: car.returnDate || '',
        returnTime: car.returnTime || '',
        carType: car.carType || '',
        confirmationNumber: car.confirmationNumber || '',
        price: car.price || '',
        notes: car.notes || '',
      }))
    : [];
  const accommodations = hasExplicitAccommodations
    ? Array.isArray(source.accommodations)
      ? source.accommodations.map((stay) => ({
          id: stay.id || uid('stay'),
          name: stay.name || '',
          type: stay.type || '',
          checkIn: stay.checkIn || '',
          checkOut: stay.checkOut || '',
          address: stay.address || '',
          notes: stay.notes || '',
        }))
      : []
    : derivedAccommodations;
  return {
    coverImageUrl: typeof source.coverImageUrl === 'string' ? source.coverImageUrl : '',
    tripNotes: typeof source.tripNotes === 'string' ? source.tripNotes : '',
    attachments: Array.isArray(source.attachments)
      ? source.attachments.map((attachment) => ({
          id: attachment.id || uid('attachment'),
          name: attachment.name || attachment.title || '',
          type: attachment.type || '',
          url: attachment.url || '',
          notes: attachment.notes || '',
        }))
      : [],
    flights: Array.isArray(source.flights)
      ? source.flights.map((flight) => ({
          id: flight.id || uid('flight'),
          from: flight.from || '',
          fromCountry: flight.fromCountry || '',
          fromAirport: flight.fromAirport || '',
          fromIata: flight.fromIata || '',
          to: flight.to || '',
          toCountry: flight.toCountry || '',
          toAirport: flight.toAirport || '',
          toIata: flight.toIata || '',
          date: flight.date || '',
          departureTime: flight.departureTime || '',
          arrivalTime: flight.arrivalTime || '',
          airline: flight.airline || '',
          flightNumber: flight.flightNumber || '',
          departureTerminal: flight.departureTerminal || flight.terminal || '',
          departureGate: flight.departureGate || flight.gate || '',
          arrivalTerminal: flight.arrivalTerminal || '',
          arrivalGate: flight.arrivalGate || '',
          price: flight.price || '',
          status: flight.status || '',
          notes: flight.notes || '',
        }))
      : [],
    accommodations,
    rentalCars,
    otherItems: Array.isArray(source.otherItems)
      ? source.otherItems.map((item) => ({
          id: item.id || uid('other'),
          name: item.name || item.label || '',
          notes: item.notes || '',
        }))
      : [],
    packingCategories: normalizePackingCategories(source.packingCategories),
    stopNotes: source.stopNotes && typeof source.stopNotes === 'object' ? source.stopNotes : {},
  };
}

function defaultFlight() {
  return {
    id: uid('flight'),
    from: '',
    fromCountry: '',
    fromAirport: '',
    fromIata: '',
    to: '',
    toCountry: '',
    toAirport: '',
    toIata: '',
    date: '',
    departureTime: '',
    arrivalTime: '',
    airline: '',
    flightNumber: '',
    departureTerminal: '',
    departureGate: '',
    arrivalTerminal: '',
    arrivalGate: '',
    price: '',
    status: '',
    notes: '',
  };
}

function defaultStay() {
  return {
    id: uid('stay'),
    name: '',
    type: 'Hotel',
    checkIn: '',
    checkOut: '',
    address: '',
    notes: '',
  };
}

function defaultRentalCar() {
  return {
    id: uid('rental-car'),
    company: '',
    pickupLocation: '',
    pickupDate: '',
    pickupTime: '',
    returnLocation: '',
    returnDate: '',
    returnTime: '',
    carType: '',
    confirmationNumber: '',
    price: '',
    notes: '',
  };
}

function groupItineraryByDay(itinerary = []) {
  const grouped = new Map();
  itinerary.forEach((item, index) => {
    const dayIndex = Number.isInteger(item.dayIndex) ? item.dayIndex : 0;
    if (!grouped.has(dayIndex)) grouped.set(dayIndex, []);
    grouped.get(dayIndex).push({ ...item, index });
  });
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayIndex, items]) => ({
      dayIndex,
      items: items.sort((a, b) => (a.start || '').localeCompare(b.start || '')),
    }));
}

function dayLabel(trip, dayIndex) {
  if (!trip?.startDate) return `Day ${dayIndex + 1}`;
  const date = parseTripDate(trip.startDate);
  if (!date) return `Day ${dayIndex + 1}`;
  date.setDate(date.getDate() + dayIndex);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
  const label = `${weekday}, ${date.getDate()} ${MONTH_LABELS[date.getMonth()]}`;
  return `Day ${dayIndex + 1} · ${label}`;
}

// [Feature #31] Reservations overview summary rows (counts of stops/flights/stays/etc.)
function buildOverviewRows(trip, dashboard, totalAttachments = dashboard?.attachments?.length || 0) {
  return [
    ['Trip name', trip?.title || 'Untitled Trip'],
    ['Dates', formatDateRange(trip?.startDate, trip?.endDate)],
    ['Stops', String((trip?.itinerary || []).length)],
    ['Flights', String(dashboard?.flights?.length || 0)],
    ['Accommodation', String(dashboard?.accommodations?.length || 0)],
    ['Rental cars', String(dashboard?.rentalCars?.length || 0)],
    ['Attachments', String(totalAttachments)],
    ['Other', String(dashboard?.otherItems?.length || 0)],
  ];
}

function flightRouteLabel(flight) {
  const from = flight?.from || 'Origin';
  const to = flight?.to || 'Destination';
  return `${from} → ${to}`;
}

function flightRouteDetail(flight, side) {
  const airport = side === 'from' ? flight?.fromAirport : flight?.toAirport;
  const country = side === 'from' ? flight?.fromCountry : flight?.toCountry;
  const iata = side === 'from' ? flight?.fromIata : flight?.toIata;
  return [country, airport, iata ? `(${iata})` : ''].filter(Boolean).join(' ');
}

function flightStatusLabel(status) {
  const value = String(status || '').trim();
  if (!value) return 'Planned';
  return value;
}

function flightDisplayValue(value) {
  const text = String(value || '').trim();
  return text || '-';
}

function fileExtension(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function attachmentContentType(file) {
  const explicit = String(file?.type || '').toLowerCase();
  if (explicit) return explicit;
  const ext = fileExtension(file?.name);
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return '';
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function validateAttachmentFile(file) {
  if (!file) return 'Choose a file to upload.';
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) return 'Files must be 10 MB or smaller.';
  const extensions = ALLOWED_ATTACHMENT_TYPES.get(attachmentContentType(file));
  if (!extensions || !extensions.includes(fileExtension(file.name))) {
    return 'Use PDF, PNG, JPG, JPEG, WEBP, or DOCX files.';
  }
  return '';
}

function relatedItemLabel(attachment, dashboard) {
  if (!attachment) return 'Trip';
  if (attachment.relatedItemType === 'flight') {
    const flight = dashboard.flights.find((item) => item.id === attachment.relatedItemId);
    return flight ? `Flight: ${flightRouteLabel(flight)}` : 'Flight';
  }
  if (attachment.relatedItemType === 'accommodation') {
    const stay = dashboard.accommodations.find((item) => item.id === attachment.relatedItemId);
    return stay ? `Accommodation: ${stay.name || 'Stay'}` : 'Accommodation';
  }
  if (attachment.relatedItemType === 'rentalCar') {
    const car = dashboard.rentalCars.find((item) => item.id === attachment.relatedItemId);
    return car ? `Rental car: ${car.company || 'Rental car'}` : 'Rental car';
  }
  return 'Trip documents';
}

function flightAirportLabel(flight, side) {
  const airport = side === 'departure' ? flight?.fromAirport : flight?.toAirport;
  const city = side === 'departure' ? flight?.from : flight?.to;
  const iata = side === 'departure' ? flight?.fromIata : flight?.toIata;
  const primary = airport || city || 'Airport';
  const secondary = [city && airport && city !== airport ? city : '', iata ? `(${iata})` : ''].filter(Boolean).join(' ');
  return { primary, secondary };
}

function sectionButtonClass(active, sectionId) {
  return `overview-nav-link${active === sectionId ? ' overview-nav-link--active' : ''}`;
}

function sectionTitle(title, subtitle) {
  return (
    <div className="overview-section-heading">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
    </div>
  );
}

function SectionShell({ id, title, subtitle, children, sectionRef }) {
  return (
    <section id={id} ref={sectionRef} className="overview-section">
      {sectionTitle(title, subtitle)}
      {children}
    </section>
  );
}

function ModalShell({ title, subtitle, onClose, children, footer, className = '' }) {
  return (
    <div className="overview-modal-backdrop" onClick={onClose}>
      <div className={`overview-modal ${className}`.trim()} onClick={(e) => e.stopPropagation()}>
        <div className="overview-modal-header">
          <div>
            <div className="overview-modal-title">{title}</div>
            {subtitle && <div className="overview-modal-helper">{subtitle}</div>}
          </div>
          <button className="overview-modal-close" onClick={onClose} type="button">×</button>
        </div>
        <div className="overview-modal-body">{children}</div>
        {footer && <div className="overview-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

function emptyExportSelection() {
  return {
    overview: true,
    flights: true,
    accommodation: true,
    rentalCars: true,
    documents: true,
    itinerary: true,
    notes: true,
    packing: true,
    alerts: true,
    fallbacks: true,
  };
}

const COUNTRY_LOOKUP_URL = 'https://restcountries.com/v3.1/all?fields=name,cca2';
let countriesPromise = null;
const airportSearchCache = new Map();
const MAX_CACHE_ENTRIES = 40;
const INITIAL_VISIBLE_SUGGESTIONS = 50;
const LOAD_MORE_SUGGESTIONS_STEP = 100;
const PASSENGER_AIRPORT_TYPES = new Set(['large_airport', 'medium_airport']);
const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Map([
  ['application/pdf', ['pdf']],
  ['image/png', ['png']],
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/webp', ['webp']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx']],
]);

function normalizeSearchText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const regionNamesEn = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;
const regionNamesHe = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['he'], { type: 'region' })
  : null;

function resolveCountryNames(airport) {
  const code = String(airport?.countryCode || airport?.country || '').toUpperCase();
  const countryName = String(airport?.countryName || '').trim() || (regionNamesEn?.of(code) || code);
  const countryNameHebrew = String(airport?.countryNameHebrew || '').trim() || (regionNamesHe?.of(code) || countryName);
  return {
    code,
    countryName,
    countryNameHebrew,
  };
}

const AIRPORT_SEARCH_INDEX = airports.filter((airport) => (
  !airport.type || PASSENGER_AIRPORT_TYPES.has(airport.type)
)).map((airport) => {
  const countryInfo = resolveCountryNames(airport);
  const entry = {
    airport,
    countryCode: normalizeSearchText(countryInfo.code),
    countryName: normalizeSearchText(countryInfo.countryName),
    countryNameHebrew: normalizeSearchText(countryInfo.countryNameHebrew),
    airportName: normalizeSearchText(airport.airportName || ''),
    city: normalizeSearchText(airport.city || ''),
    iata: normalizeSearchText(airport.iata || ''),
    icao: normalizeSearchText(airport.icao || ''),
  };
  entry.searchableText = [
    entry.countryCode,
    entry.countryName,
    entry.countryNameHebrew,
    entry.airportName,
    entry.city,
    entry.iata,
    entry.icao,
  ].filter(Boolean).join(' ');
  return entry;
});

const AIRPORT_COORDS_BY_IATA = new Map(
  airports
    .filter((airport) => airport.iata && Number.isFinite(airport.latitude) && Number.isFinite(airport.longitude))
    .map((airport) => [String(airport.iata).toUpperCase(), { lat: airport.latitude, lng: airport.longitude }])
);

function airportCoordsByIata(iata) {
  if (!iata) return null;
  return AIRPORT_COORDS_BY_IATA.get(String(iata).trim().toUpperCase()) || null;
}

function getCachedSourceEntries(query) {
  // If user keeps typing, re-filter previous result-set instead of scanning all airports again.
  for (let i = query.length - 1; i >= 1; i -= 1) {
    const cached = airportSearchCache.get(query.slice(0, i));
    if (cached?.entries?.length) return cached.entries;
  }
  return AIRPORT_SEARCH_INDEX;
}

function rememberSearchCache(query, entries, results) {
  airportSearchCache.set(query, { entries, results });
  if (airportSearchCache.size <= MAX_CACHE_ENTRIES) return;
  const firstKey = airportSearchCache.keys().next().value;
  if (firstKey) airportSearchCache.delete(firstKey);
}

function loadCountries() {
  if (!countriesPromise) {
    countriesPromise = fetch(COUNTRY_LOOKUP_URL)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => (Array.isArray(data) ? data : [])
        .map((entry) => ({
          name: entry?.name?.common || '',
          code: entry?.cca2 || '',
        }))
        .filter((entry) => entry.name)
        .sort((a, b) => a.name.localeCompare(b.name)))
      .catch(() => []);
  }
  return countriesPromise;
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  const c = code.toUpperCase();
  try {
    return String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65, 0x1F1E6 + c.charCodeAt(1) - 65);
  } catch {
    return '';
  }
}

function airportDisplayLabel(countryName, airportName) {
  return countryName ? `${countryName}, ${airportName}` : airportName;
}

function parseFlightSuggestion(r, countryName = '') {
  const addr = r.address || {};
  const nd = r.namedetails || {};
  const airportName = (nd['name:en'] || nd['name:he'] || r.name || r.display_name.split(',')[0].trim() || '').trim();
  const country = countryName || addr.country || '';
  const iata = String(r.extratags?.iata || r.extratags?.IATA || r.extratags?.iata_code || '').trim().toUpperCase();
  return {
    label: airportDisplayLabel(country, airportName),
    short: airportDisplayLabel(country, airportName),
    subtitle: iata || airportName,
    country,
    airportName,
    iata,
    flag: countryFlag(addr.country_code || ''),
    icon: '✈️',
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    kind: 'airport',
  };
}

// [Feature #32] Flight airport autocomplete over the bundled 6k+ airport database
async function searchFlightSuggestions(query) {
  const normalized = normalizeSearchText(query);
  if (normalized.length < 1) return [];

  const cached = airportSearchCache.get(normalized);
  if (cached?.results) return cached.results;

  const q = normalized.toLowerCase();
  const qTokens = q.split(/\s+/).filter(Boolean);
  const sourceEntries = getCachedSourceEntries(q);

  // Score matches across multiple fields: country code/name (en/he), airport, city, IATA, ICAO.
  const scored = [];
  for (let i = 0; i < sourceEntries.length; i += 1) {
    const entry = sourceEntries[i];
    const {
      countryCode,
      countryName,
      countryNameHebrew,
      airportName,
      city,
      iata,
      icao,
      searchableText,
    } = entry;

    let score = 0;
    if (iata && iata === q) score = 100;
    if (icao && icao === q) score = Math.max(score, 90);
    if (countryCode && countryCode === q) score = Math.max(score, 95);
    if (countryName && countryName === q) score = Math.max(score, 92);
    if (countryNameHebrew && countryNameHebrew === q) score = Math.max(score, 92);

    if (iata && iata.startsWith(q)) score = Math.max(score, 80);
    if (icao && icao.startsWith(q)) score = Math.max(score, 75);
    if (countryCode && countryCode.startsWith(q)) score = Math.max(score, 78);
    if (airportName.startsWith(q)) score = Math.max(score, 70);
    if (countryName.startsWith(q) || countryNameHebrew.startsWith(q)) score = Math.max(score, 60);
    if (city.startsWith(q)) score = Math.max(score, 55);
    if (airportName.includes(q)) score = Math.max(score, 40);
    if (countryName.includes(q) || countryNameHebrew.includes(q) || countryCode.includes(q)) score = Math.max(score, 30);
    if (city.includes(q)) score = Math.max(score, 25);

    const countryDirectMatch = (countryCode && countryCode === q) || (countryName && countryName === q) || (countryNameHebrew && countryNameHebrew === q);
    const countryContainsMatch = (countryName && countryName.includes(q))
      || (countryNameHebrew && countryNameHebrew.includes(q))
      || (countryCode && countryCode.includes(q));

    // When searching by country (e.g. "ישראל"), prioritize airports with IATA codes so major airports appear first.
    if (countryDirectMatch && iata) score = Math.max(score, 96);
    else if (countryContainsMatch && iata) score = Math.max(score, 58);

    if (qTokens.length > 1 && qTokens.every((token) => searchableText.includes(token))) {
      score = Math.max(score, 65);
    }

    if (score > 0) scored.push({ score, entry });
  }

  scored.sort((x, y) => (
    (y.score - x.score)
    || (Number(Boolean(y.entry.airport.iata)) - Number(Boolean(x.entry.airport.iata)))
    || (Number(Boolean(y.entry.airport.icao)) - Number(Boolean(x.entry.airport.icao)))
    || String(x.entry.airport.airportName || '').localeCompare(String(y.entry.airport.airportName || ''))
  ));
  const matchedEntries = scored.map(({ entry }) => entry);
  const results = matchedEntries.map((entry) => {
    const a = entry.airport;
    const countryInfo = resolveCountryNames(a);
    return {
      label: `${countryInfo.countryName}, ${a.airportName}${a.iata ? ` (${a.iata})` : ''}`,
      subtitle: [a.city, countryInfo.code, countryInfo.countryNameHebrew].filter(Boolean).join(' · '),
      iata: a.iata || '',
      icao: a.icao || '',
      country: countryInfo.countryName,
      countryCode: countryInfo.code,
      countryName: countryInfo.countryName,
      countryNameHebrew: countryInfo.countryNameHebrew,
      airportName: a.airportName || '',
      latitude: a.latitude || null,
      longitude: a.longitude || null,
      kind: 'airport',
      short: `${a.airportName}${a.iata ? ` (${a.iata})` : ''}`,
    };
  });

  // Deduplicate by country+airport+iata
  const dedup = [];
  const seen = new Set();
  for (const r of results) {
    const key = `${normalizeSearchText(r.countryCode || r.country)}::${normalizeSearchText(r.airportName)}::${normalizeSearchText(r.iata || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(r);
  }

  rememberSearchCache(q, matchedEntries, dedup);
  return dedup;
}

function PlaceAutocompleteField({ label, value, placeholder, onChange, onSelectPlace }) {
  const [query, setQuery] = useState(value || '');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_SUGGESTIONS);
  const [loading, setLoading] = useState(false);
  const wrapperRef = useRef(null);
  const debouncedQuery = useDebounce(query, 280);
  const visibleSuggestions = suggestions.slice(0, visibleCount);

  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    let alive = true;
    if (normalizeSearchText(debouncedQuery).length < 1) {
      setSuggestions([]);
      setVisibleCount(INITIAL_VISIBLE_SUGGESTIONS);
      setOpen(false);
      return () => { alive = false; };
    }
    setLoading(true);
    searchFlightSuggestions(debouncedQuery.trim())
      .then((results) => {
        if (!alive) return;
        setSuggestions(results || []);
        setVisibleCount(INITIAL_VISIBLE_SUGGESTIONS);
        setOpen((results || []).length > 0);
        setActiveIdx(-1);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => { alive = false; };
  }, [debouncedQuery]);

  useEffect(() => {
    const handler = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function pickSuggestion(suggestion) {
    const nextValue = suggestion.short || suggestion.label || '';
    setQuery(nextValue);
    onChange(nextValue);
    onSelectPlace?.(suggestion);
    setSuggestions([]);
    setVisibleCount(INITIAL_VISIBLE_SUGGESTIONS);
    setOpen(false);
  }

  function handleKeyDown(event) {
    if (!open || suggestions.length === 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIdx((idx) => Math.min(idx + 1, suggestions.length - 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIdx((idx) => Math.max(idx - 1, 0)); }
    if (event.key === 'Enter' && activeIdx >= 0) { event.preventDefault(); pickSuggestion(suggestions[activeIdx]); }
    if (event.key === 'Escape') setOpen(false);
  }

  return (
    <div className="flight-autocomplete" ref={wrapperRef}>
      <label className="overview-modal-field">
        <span>{label}</span>
        <div className="flight-autocomplete-input-row">
          <input
            className="trips-modal-input flight-autocomplete-input"
            value={query}
            placeholder={placeholder}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              onChange(next);
              setOpen(true);
            }}
            onFocus={() => query.trim().length >= 1 && suggestions.length > 0 && setOpen(true)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
          />
          {loading && <span className="flight-autocomplete-spinner">⋯</span>}
        </div>
      </label>
      {open && suggestions.length > 0 && (
        <ul className="autocomplete-dropdown flight-autocomplete-dropdown">
          {visibleSuggestions.map((suggestion, index) => (
            <li
              key={`${suggestion.label}-${index}`}
              className={`autocomplete-item ${index === activeIdx ? 'autocomplete-item--active' : ''}`}
              onMouseDown={() => pickSuggestion(suggestion)}
            >
              <span className="autocomplete-pin">✈️</span>
              <span className="autocomplete-texts">
                <span className="autocomplete-label">{suggestion.label}</span>
                <span className="autocomplete-full">{suggestion.iata ? `${suggestion.subtitle} · ${suggestion.iata}` : suggestion.subtitle}</span>
              </span>
              {suggestion.iata && <span className="flight-autocomplete-badge">{suggestion.iata}</span>}
            </li>
          ))}
          {visibleCount < suggestions.length && (
            <li className="autocomplete-item autocomplete-item--load-more" onMouseDown={(event) => event.preventDefault()}>
              <button
                type="button"
                className="overview-inline-btn overview-inline-btn--small"
                onClick={() => setVisibleCount((count) => Math.min(count + LOAD_MORE_SUGGESTIONS_STEP, suggestions.length))}
              >
                Show more ({suggestions.length - visibleCount} more)
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function TripOverviewPage() {
  const { tripId } = useParams();
  const navigate = useNavigate();
  const [trip, setTrip] = useState(null);
  const [dashboard, setDashboard] = useState(normalizeDashboard());
  const [alerts, setAlerts] = useState([]);
  const [fallbacks, setFallbacks] = useState({});
  const [weather, setWeather] = useState({});
  const [attachments, setAttachments] = useState([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentStatus, setAttachmentStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveStatus, setSaveStatus] = useState('saved');
  const [activeSection, setActiveSection] = useState('overview');
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportSelection, setExportSelection] = useState(emptyExportSelection());
  const [exportFormat, setExportFormat] = useState('pdf');

  const [flightModal, setFlightModal] = useState(null);
  const [stayModal, setStayModal] = useState(null);
  const [rentalCarModal, setRentalCarModal] = useState(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryItemDrafts, setCategoryItemDrafts] = useState({});
  const [packingEdit, setPackingEdit] = useState(null);
  const [selectedPackingCategoryId, setSelectedPackingCategoryId] = useState('');
  const [generalNotesDraft, setGeneralNotesDraft] = useState('');
  const [noteDrafts, setNoteDrafts] = useState({});
  const [heroImages, setHeroImages] = useState([]);
  const [heroIndex, setHeroIndex] = useState(0);

  const versionRef = useRef(1);
  const saveTimerRef = useRef(null);
  const sectionRefs = useRef({});
  const coverImages = useMemo(() => loadLocalImages(), []);
  const coverImage = dashboard.coverImageUrl || coverImages[tripId] || '';
  const heroFallback = useMemo(() => {
    if (coverImage) return [coverImage];
    return [];
  }, [coverImage]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setAttachmentsLoading(true);
    Promise.all([
      api.getTrip(tripId),
      api.getTripAlerts(tripId).catch(() => null),
      api.getTripFallbacks(tripId).catch(() => null),
      api.getTripWeather(tripId).catch(() => null),
      api.getTripAttachments(tripId).catch(() => null),
    ])
      .then(([tripRes, alertsRes, fallbacksRes, weatherRes, attachmentsRes]) => {
        if (cancelled) return;
        setTrip(tripRes.trip);
        versionRef.current = tripRes.trip.version || 1;
        const nextDashboard = normalizeDashboard(tripRes.trip.metadata?.tripOverview, tripRes.trip);
        setDashboard(nextDashboard);
        setGeneralNotesDraft(nextDashboard.tripNotes || '');
        setNoteDrafts(nextDashboard.stopNotes || {});
        if (alertsRes) {
          setAlerts(alertsRes.alerts || []);
        }
        if (fallbacksRes) {
          const map = {};
          (fallbacksRes.fallbacks || []).forEach((fallback) => {
            map[fallback.slotId] = fallback.suggestions || [];
          });
          setFallbacks(map);
        }
        if (weatherRes) {
          const map = {};
          (weatherRes.weather || []).forEach((item) => {
            map[item.slotId] = item;
          });
          setWeather(map);
        }
        setAttachments(Array.isArray(attachmentsRes?.items) ? attachmentsRes.items : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load trip');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setAttachmentsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(saveTimerRef.current);
    };
  }, [tripId]);

  useEffect(() => {
    if (!dashboard.packingCategories.length) {
      setSelectedPackingCategoryId('');
      return;
    }
    const currentExists = dashboard.packingCategories.some((category) => category.id === selectedPackingCategoryId);
    if (!currentExists) {
      setSelectedPackingCategoryId(dashboard.packingCategories[0].id);
    }
  }, [dashboard.packingCategories, selectedPackingCategoryId]);

  useEffect(() => {
    let cancelled = false;

    // [Feature #39] Build the rotating hero image set (custom cover + Wikipedia photos)
    async function loadHeroImages() {
      if (!trip) return;
      const terms = buildHeroSearchTerms(trip, dashboard);
      const images = [];

      if (dashboard.coverImageUrl) {
        images.push(dashboard.coverImageUrl);
      }
      if (coverImages[tripId] && !images.includes(coverImages[tripId])) {
        images.push(coverImages[tripId]);
      }

      for (const term of terms) {
        if (term === '__custom__') continue;
        try {
          const image = await fetchWikiThumbnail(term);
          if (cancelled) return;
          if (image && !images.includes(image)) images.push(image);
          if (images.length >= 4) break;
        } catch {
          // Ignore image fetch failures and keep the card usable.
        }
      }

      if (!cancelled) {
        setHeroImages(images.length > 0 ? images : heroFallback);
        setHeroIndex(0);
      }
    }

    loadHeroImages();
    return () => { cancelled = true; };
  }, [trip, dashboard.coverImageUrl, coverImage, tripId, coverImages, heroFallback]);

  useEffect(() => {
    if (heroImages.length <= 1) return undefined;
    const timer = setInterval(() => {
      setHeroIndex((current) => (current + 1) % heroImages.length);
    }, 6500);
    return () => clearInterval(timer);
  }, [heroImages]);

  useEffect(() => {
    const sections = Object.values(sectionRefs.current).filter(Boolean);
    if (sections.length === 0) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target?.id) setActiveSection(visible.target.id);
      },
      { rootMargin: '-18% 0px -55% 0px', threshold: [0.12, 0.25, 0.5, 0.75] },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [trip, dashboard]);

  function scrollToSection(id) {
    const target = sectionRefs.current[id];
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function persistDashboard(nextDashboard, nextItinerary) {
    if (!trip) return;
    setSaveStatus('saving');
    clearTimeout(saveTimerRef.current);
    try {
      const mergedMetadata = {
        ...(trip.metadata || {}),
        tripOverview: nextDashboard,
      };
      const payload = {
        metadata: mergedMetadata,
        version: versionRef.current,
      };
      if (nextItinerary) payload.itinerary = nextItinerary;
      const res = await api.updateTrip(tripId, payload);
      const updatedTrip = res.trip;
      versionRef.current = updatedTrip.version || versionRef.current + 1;
      setTrip(updatedTrip);
      const next = normalizeDashboard(updatedTrip.metadata?.tripOverview, updatedTrip);
      setDashboard(next);
      setGeneralNotesDraft(next.tripNotes || '');
      setNoteDrafts(next.stopNotes || {});
      setSaveStatus('saved');
    } catch (err) {
      setSaveStatus('unsaved');
      if (err.code === 'VERSION_CONFLICT') {
        setError('Version conflict — someone else edited this trip. Refresh to get the latest data.');
      } else {
        setError(err.message || 'Failed to save trip overview');
      }
    }
  }

  function updateDashboard(next, nextItinerary) {
    const nextDashboard = typeof next === 'function' ? next(dashboard) : next;
    setDashboard(nextDashboard);
    persistDashboard(nextDashboard, nextItinerary);
  }

  function updateFlights(nextFlights, nextItinerary) {
    updateDashboard((current) => ({ ...current, flights: nextFlights }), nextItinerary);
  }

  function updateAccommodations(nextAccommodations) {
    updateDashboard((current) => ({ ...current, accommodations: nextAccommodations }));
  }

  function updateRentalCars(nextRentalCars) {
    updateDashboard((current) => ({ ...current, rentalCars: nextRentalCars }));
  }

  function updatePackingCategories(nextPackingCategories) {
    updateDashboard((current) => ({ ...current, packingCategories: nextPackingCategories }));
  }

  function updateStopNotes(nextStopNotes) {
    updateDashboard((current) => ({ ...current, stopNotes: nextStopNotes }));
  }

  // [Feature #36] Save trip-level free-text notes
  function saveGeneralNotes() {
    updateDashboard((current) => ({ ...current, tripNotes: generalNotesDraft }));
  }

  function setAttachmentActionStatus(key, status) {
    setAttachmentStatus((current) => ({ ...current, [key]: status }));
  }

  function clearAttachmentActionStatus(key) {
    setAttachmentStatus((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  // [Feature #35] Upload a trip document: presigned S3 PUT, then confirm metadata
  async function uploadAttachment(file, relatedItemType = 'general', relatedItemId = null) {
    const validationError = validateAttachmentFile(file);
    const statusKey = `${relatedItemType}:${relatedItemId || 'general'}:upload`;
    if (validationError) {
      setAttachmentActionStatus(statusKey, { state: 'error', message: validationError });
      return;
    }
    setAttachmentActionStatus(statusKey, { state: 'loading', message: 'Uploading...' });
    try {
      const payload = {
        fileName: file.name,
        fileType: attachmentContentType(file),
        fileSize: file.size,
        relatedItemType,
        relatedItemId,
      };
      let uploadRequest;
      try {
        uploadRequest = await api.createAttachmentUploadUrl(tripId, payload);
      } catch (err) {
        throw new Error(`Could not prepare upload: ${err.message || 'request failed'}`);
      }
      const { fileId, s3Key, uploadUrl } = uploadRequest;
      try {
        await api.uploadToSignedUrl(uploadUrl, file);
      } catch (err) {
        throw new Error(err.message || 'File upload to S3 failed');
      }
      let res;
      try {
        res = await api.completeAttachmentUpload(tripId, fileId, { ...payload, s3Key });
      } catch (err) {
        throw new Error(`Upload reached S3, but metadata could not be saved: ${err.message || 'request failed'}`);
      }
      setAttachments((current) => [res.attachment, ...current.filter((item) => item.fileId !== res.attachment.fileId)]);
      setAttachmentActionStatus(statusKey, { state: 'success', message: 'Uploaded' });
      setTimeout(() => clearAttachmentActionStatus(statusKey), 2200);
    } catch (err) {
      setAttachmentActionStatus(statusKey, { state: 'error', message: err.message || 'Upload failed' });
    }
  }

  async function openAttachment(attachment) {
    const statusKey = `${attachment.fileId}:open`;
    setAttachmentActionStatus(statusKey, { state: 'loading', message: 'Opening...' });
    try {
      const res = await api.getAttachmentDownloadUrl(tripId, attachment.fileId);
      window.open(res.downloadUrl, '_blank', 'noopener,noreferrer');
      clearAttachmentActionStatus(statusKey);
    } catch (err) {
      setAttachmentActionStatus(statusKey, { state: 'error', message: err.message || 'Could not open file' });
    }
  }

  async function deleteAttachment(attachment) {
    const statusKey = `${attachment.fileId}:delete`;
    setAttachmentActionStatus(statusKey, { state: 'loading', message: 'Deleting...' });
    try {
      await api.deleteAttachment(tripId, attachment.fileId);
      setAttachments((current) => current.filter((item) => item.fileId !== attachment.fileId));
      clearAttachmentActionStatus(statusKey);
    } catch (err) {
      setAttachmentActionStatus(statusKey, { state: 'error', message: err.message || 'Delete failed' });
    }
  }

  function attachmentsFor(relatedItemType, relatedItemId = null) {
    return attachments.filter((attachment) => (
      attachment.relatedItemType === relatedItemType
      && (relatedItemType === 'general' || attachment.relatedItemId === relatedItemId)
    ));
  }

  function openFlightModal(flight = defaultFlight()) {
    setFlightModal(flight);
  }

  function openStayModal(stay = defaultStay()) {
    setStayModal(stay);
  }

  function openRentalCarModal(rentalCar = defaultRentalCar()) {
    setRentalCarModal(rentalCar);
  }

  // [Feature #32] Create/update a flight reservation, and mirror it onto the trip-plan
  // map as an itinerary stop on its landing day/time (see deriveItineraryStopFromFlight)
  function saveFlightFlight(draft) {
    if (!isFlightDateWithinTrip(draft.date, trip)) return;
    const flights = [...dashboard.flights];
    const index = flights.findIndex((flight) => flight.id === draft.id);
    if (index >= 0) flights[index] = draft;
    else flights.push(draft);
    const itinerary = applyFlightToItinerary(trip?.itinerary || [], draft, trip);
    updateFlights(flights, itinerary);
    setFlightModal(null);
  }

  // [Feature #33] Create/update an accommodation reservation
  function saveStayDraft(draft) {
    const accommodations = [...dashboard.accommodations];
    const index = accommodations.findIndex((stay) => stay.id === draft.id);
    if (index >= 0) accommodations[index] = draft;
    else accommodations.push(draft);
    updateAccommodations(accommodations);
    setStayModal(null);
  }

  // [Feature #34] Create/update a rental car reservation
  function saveRentalCarDraft(draft) {
    const rentalCars = [...dashboard.rentalCars];
    const index = rentalCars.findIndex((car) => car.id === draft.id);
    if (index >= 0) rentalCars[index] = draft;
    else rentalCars.push(draft);
    updateRentalCars(rentalCars);
    setRentalCarModal(null);
  }

  function removeFlight(flightId) {
    const itinerary = removeFlightFromItinerary(trip?.itinerary || [], flightId);
    updateFlights(dashboard.flights.filter((flight) => flight.id !== flightId), itinerary);
  }

  function removeStay(stayId) {
    updateAccommodations(dashboard.accommodations.filter((stay) => stay.id !== stayId));
  }

  function removeRentalCar(rentalCarId) {
    updateRentalCars(dashboard.rentalCars.filter((car) => car.id !== rentalCarId));
  }

  // [Feature #37] Packing list — add a category
  function addCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    const nextCategory = { id: uid('cat'), name, items: [] };
    const next = [...dashboard.packingCategories, nextCategory];
    setNewCategoryName('');
    updatePackingCategories(next);
    setSelectedPackingCategoryId(nextCategory.id);
  }

  // [Feature #37] Packing list — add / check / remove items within a category
  function addPackingItem(categoryId) {
    const label = (categoryItemDrafts[categoryId] || '').trim();
    if (!label) return;
    const next = dashboard.packingCategories.map((category) => {
      if (category.id !== categoryId) return category;
      return {
        ...category,
        items: [...category.items, { id: uid('item'), label, checked: false }],
      };
    });
    setCategoryItemDrafts((prev) => ({ ...prev, [categoryId]: '' }));
    updatePackingCategories(next);
  }

  function togglePackingItem(categoryId, itemId) {
    const next = dashboard.packingCategories.map((category) => {
      if (category.id !== categoryId) return category;
      return {
        ...category,
        items: category.items.map((item) => (item.id === itemId ? { ...item, checked: !item.checked } : item)),
      };
    });
    updatePackingCategories(next);
  }

  function deletePackingItem(categoryId, itemId) {
    const next = dashboard.packingCategories.map((category) => {
      if (category.id !== categoryId) return category;
      return {
        ...category,
        items: category.items.filter((item) => item.id !== itemId),
      };
    });
    updatePackingCategories(next);
    setPackingEdit((current) => (current && current.itemId === itemId ? null : current));
  }

  function deletePackingCategory(categoryId) {
    updatePackingCategories(dashboard.packingCategories.filter((category) => category.id !== categoryId));
    setCategoryItemDrafts((prev) => {
      const next = { ...prev };
      delete next[categoryId];
      return next;
    });
  }

  function savePackingEdit() {
    if (!packingEdit) return;
    const label = packingEdit.label.trim();
    if (!label) return;
    const next = dashboard.packingCategories.map((category) => {
      if (category.id !== packingEdit.categoryId) return category;
      return {
        ...category,
        items: category.items.map((item) => (item.id === packingEdit.itemId ? { ...item, label } : item)),
      };
    });
    updatePackingCategories(next);
    setPackingEdit(null);
  }

  // [Feature #36] Save a per-stop note
  function saveStopNote(slotId) {
    updateStopNotes({ ...dashboard.stopNotes, [slotId]: noteDrafts[slotId] || '' });
  }

  function removeStopNote(slotId) {
    const next = { ...dashboard.stopNotes };
    delete next[slotId];
    setNoteDrafts((prev) => {
      const copy = { ...prev };
      delete copy[slotId];
      return copy;
    });
    updateStopNotes(next);
  }

  function prepareExportSelection(selectAll = true) {
    const next = emptyExportSelection();
    Object.keys(next).forEach((key) => {
      next[key] = selectAll;
    });
    setExportSelection(next);
  }

  function sectionRowsToSheet(rows) {
    return XLSX.utils.aoa_to_sheet(rows);
  }

  // [Feature #38] Export the selected sections as a multi-sheet Excel workbook (XLSX)
  function exportExcel() {
    const workbook = XLSX.utils.book_new();
    const selected = exportSelection;

    if (selected.overview) {
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet([
        ['Field', 'Value'],
        ...buildOverviewRows(trip, dashboard, attachments.length),
      ]), 'Overview');
    }

    if (selected.flights) {
      const rows = [
        ['From', 'To', 'Date', 'Depart', 'Arrive', 'Airline', 'Flight #', 'Price', 'Status', 'Notes'],
        ...dashboard.flights.map((flight) => [
          flight.from,
          flight.to,
          flight.date,
          flight.departureTime,
          flight.arrivalTime,
          flight.airline,
          flight.flightNumber,
           flight.price || '0',
          flight.status,
          flight.notes,
        ]),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Flights');
    }

    if (selected.accommodation) {
      const rows = [
        ['Name', 'Type', 'Check-in', 'Check-out', 'Address', 'Notes'],
        ...dashboard.accommodations.map((stay) => [stay.name, stay.type, stay.checkIn, stay.checkOut, stay.address, stay.notes]),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Accommodation');
    }

    if (selected.rentalCars && dashboard.rentalCars.length > 0) {
      const rows = [
        ['Company', 'Pickup location', 'Pickup date', 'Pickup time', 'Return location', 'Return date', 'Return time', 'Car type', 'Confirmation #', 'Price', 'Notes'],
        ...dashboard.rentalCars.map((car) => [car.company, car.pickupLocation, car.pickupDate, car.pickupTime, car.returnLocation, car.returnDate, car.returnTime, car.carType, car.confirmationNumber, car.price, car.notes]),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Rental Cars');
    }

    if (selected.documents && attachments.length > 0) {
      const rows = [
        ['File name', 'Belongs to', 'Type', 'Size', 'Uploaded'],
        ...attachments.map((attachment) => [
          attachment.fileName,
          relatedItemLabel(attachment, dashboard),
          attachment.fileType,
          formatFileSize(attachment.fileSize),
          formatDisplayDate(attachment.uploadedAt),
        ]),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Documents');
    }

    if (selected.itinerary) {
      const rows = [
        ['Day', 'Time', 'Stop', 'Notes'],
        ...((trip?.itinerary || []).map((stop) => [
          dayLabel(trip, stop.dayIndex || 0),
          stop.start ? formatTime(stop.start) : '',
          stop.title || 'Stop',
          dashboard.stopNotes[stop.slotId] || '',
        ])),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Itinerary');
    }

    if (selected.notes) {
      const rows = [
        ['Type', 'Note'],
        ['General trip notes', dashboard.tripNotes || ''],
        ...((trip?.itinerary || []).map((stop) => [`Stop: ${stop.title || 'Stop'}`, dashboard.stopNotes[stop.slotId] || ''])),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Notes');
    }

    if (selected.packing) {
      const rows = [
        ['Category', 'Item', 'Packed'],
        ...dashboard.packingCategories.flatMap((category) => category.items.map((item) => [category.name, item.label, item.checked ? 'Yes' : 'No'])),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Packing List');
    }

    if (selected.alerts) {
      const rows = [
        ['Stop', 'Reason'],
        ...alerts.map((alert) => [alert.slotTitle || alert.slotId || 'Stop', alert.reason || 'Weather alert']),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Weather Alerts');
    }

    if (selected.fallbacks) {
      const rows = [
        ['Stop', 'Suggestion', 'Category'],
        ...Object.entries(fallbacks).flatMap(([slotId, suggestions]) => (suggestions || []).map((suggestion) => [slotId, suggestion.name || '', suggestion.category || ''])),
      ];
      XLSX.utils.book_append_sheet(workbook, sectionRowsToSheet(rows), 'Fallbacks');
    }

    XLSX.writeFile(workbook, `${trip?.title || 'TripWiz'}-overview.xlsx`);
  }

  // [Feature #38] Export the selected sections as a styled multi-section PDF (jsPDF)
  function exportPdf() {
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 40;
    let y = margin;
    const pageWidth = doc.internal.pageSize.getWidth();
    const contentWidth = pageWidth - margin * 2;

    doc.setFont('helvetica', 'normal');

    function addPageHeader() {
      doc.setFillColor(99, 102, 241);
      doc.rect(0, 0, pageWidth, 96, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(24);
      doc.setFont('helvetica', 'bold');
      doc.text(trip?.title || 'Trip Overview', margin, 38);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.text(formatDateRange(trip?.startDate, trip?.endDate), margin, 62);
      y = 122;
    }

    function addHeading(text) {
      if (y > doc.internal.pageSize.getHeight() - 70) {
        doc.addPage();
        addPageHeader();
      }
      doc.setFontSize(16);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(15, 23, 42);
      doc.text(text, margin, y);
      y += 18;
    }

    function addParagraph(text) {
      if (!text) return;
      const lines = doc.splitTextToSize(String(text), contentWidth);
      if (y + lines.length * 12 > doc.internal.pageSize.getHeight() - 50) {
        doc.addPage();
        addPageHeader();
      }
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(51, 65, 85);
      doc.text(lines, margin, y);
      y += lines.length * 12 + 8;
    }

    function addTable(headers, rows) {
      autoTable(doc, {
        startY: y,
        head: [headers],
        body: rows,
        theme: 'striped',
        styles: { fontSize: 9, cellPadding: 6, valign: 'top', font: 'helvetica' },
        headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        margin: { left: margin, right: margin },
      });
      y = doc.lastAutoTable.finalY + 16;
    }

    addPageHeader();

    if (exportSelection.overview) {
      addHeading('Overview');
      addTable(['Field', 'Value'], buildOverviewRows(trip, dashboard, attachments.length));
    }

    if (exportSelection.flights && dashboard.flights.length > 0) {
      addHeading('Flights');
      addTable(
        ['From', 'To', 'Date', 'Depart', 'Arrive', 'Airline', 'Flight #', 'Price', 'Status'],
        dashboard.flights.map((flight) => [
          flight.from,
          flight.to,
          flight.date,
          flight.departureTime,
          flight.arrivalTime,
          flight.airline,
          flight.flightNumber,
          flight.price,
          flight.status,
        ]),
      );
    }

    if (exportSelection.accommodation && dashboard.accommodations.length > 0) {
      addHeading('Accommodation');
      addTable(
        ['Name', 'Type', 'Check-in', 'Check-out', 'Address'],
        dashboard.accommodations.map((stay) => [stay.name, stay.type, stay.checkIn, stay.checkOut, stay.address]),
      );
    }

    if (exportSelection.rentalCars && dashboard.rentalCars.length > 0) {
      addHeading('Rental Cars');
      addTable(
        ['Company', 'Pickup', 'Pickup date', 'Pickup time', 'Return', 'Return date', 'Return time', 'Car type', 'Confirmation #', 'Price'],
        dashboard.rentalCars.map((car) => [
          car.company,
          car.pickupLocation,
          car.pickupDate,
          car.pickupTime,
          car.returnLocation,
          car.returnDate,
          car.returnTime,
          car.carType,
          car.confirmationNumber,
          car.price,
        ]),
      );
    }

    if (exportSelection.documents && attachments.length > 0) {
      addHeading('Trip Documents');
      addTable(
        ['File name', 'Belongs to', 'Type', 'Size', 'Uploaded'],
        attachments.map((attachment) => [
          attachment.fileName,
          relatedItemLabel(attachment, dashboard),
          attachment.fileType,
          formatFileSize(attachment.fileSize),
          formatDisplayDate(attachment.uploadedAt),
        ]),
      );
    }

    if (exportSelection.itinerary && (trip?.itinerary || []).length > 0) {
      addHeading('Daily Itinerary');
      addTable(
        ['Day', 'Time', 'Stop', 'Note'],
        (trip?.itinerary || []).map((stop) => [
          dayLabel(trip, stop.dayIndex || 0),
          stop.start ? formatTime(stop.start) : '',
          stop.title || 'Stop',
          dashboard.stopNotes[stop.slotId] || '',
        ]),
      );
    }

    if (exportSelection.notes && (dashboard.tripNotes || Object.keys(dashboard.stopNotes || {}).length > 0)) {
      addHeading('Notes');
      if (dashboard.tripNotes) addParagraph(dashboard.tripNotes);
      const rows = (trip?.itinerary || []).map((stop) => [stop.title || 'Stop', dashboard.stopNotes[stop.slotId] || '']);
      addTable(['Stop', 'Note'], rows);
    }

    if (exportSelection.packing) {
      addHeading('Packing List');
      const rows = dashboard.packingCategories.flatMap((category) => category.items.map((item) => [category.name, item.label, item.checked ? 'Packed' : 'Pending']));
      if (rows.length > 0) addTable(['Category', 'Item', 'Status'], rows);
    }

    if (exportSelection.alerts && alerts.length > 0) {
      addHeading('Weather Alerts');
      addTable(['Stop', 'Reason'], alerts.map((alert) => [alert.slotTitle || alert.slotId || 'Stop', alert.reason || 'Weather alert']));
    }

    if (exportSelection.fallbacks && Object.keys(fallbacks).length > 0) {
      addHeading('Fallback Suggestions');
      const rows = Object.entries(fallbacks).flatMap(([slotId, suggestions]) => (suggestions || []).map((suggestion) => [slotId, suggestion.name || '', suggestion.category || '']));
      if (rows.length > 0) addTable(['Stop', 'Suggestion', 'Category'], rows);
    }

    doc.save(`${trip?.title || 'TripWiz'}-overview.pdf`);
  }

  function runExport() {
    if (exportFormat === 'excel') exportExcel();
    else exportPdf();
    setShowExportModal(false);
  }

  function toggleCategoryEdit(categoryId, currentName) {
    setPackingEdit({ categoryId, itemId: null, label: currentName, type: 'category' });
  }

  function saveCategoryEdit() {
    if (!packingEdit || packingEdit.type !== 'category') return;
    const name = packingEdit.label.trim();
    if (!name) return;
    const next = dashboard.packingCategories.map((category) => (category.id === packingEdit.categoryId ? { ...category, name } : category));
    updatePackingCategories(next);
    setPackingEdit(null);
  }

  if (loading) {
    return <div className="loading">Loading trip overview…</div>;
  }

  if (!trip) {
    return (
      <div className="trip-overview-page trip-overview-page--empty">
        <div className="error-banner" style={{ margin: '2rem' }}>
          {error || 'Trip not found'}
        </div>
        <button className="link-btn" onClick={() => navigate('/trips')}>← Back to trips</button>
      </div>
    );
  }

  const itineraryGroups = groupItineraryByDay(trip.itinerary || []);
  const selectedPackingCount = dashboard.packingCategories.reduce((sum, category) => sum + category.items.filter((item) => item.checked).length, 0);
  const selectedPackingCategory = dashboard.packingCategories.find((category) => category.id === selectedPackingCategoryId) || dashboard.packingCategories[0] || null;
  const selectedPackingTotal = selectedPackingCategory?.items.length || 0;
  const selectedPackingDone = selectedPackingCategory?.items.filter((item) => item.checked).length || 0;
  const selectedPackingProgress = selectedPackingTotal > 0 ? Math.round((selectedPackingDone / selectedPackingTotal) * 100) : 0;
  const flightCount = dashboard.flights.length;
  const stayCount = dashboard.accommodations.length;
  const rentalCarCount = dashboard.rentalCars.length;
  const attachmentCount = attachments.length;
  const otherCount = dashboard.otherItems.length;
  const totalStops = (trip.itinerary || []).length;
  const heroSlides = heroImages.length > 0 ? heroImages : heroFallback;
  const currentHero = heroSlides.length > 0 ? heroSlides[heroIndex % heroSlides.length] : '';
  const reservationSummaryItems = [
    { key: 'flights', label: 'Flights', count: flightCount, icon: <Plane size={22} strokeWidth={2.1} />, tone: 'flight' },
    { key: 'accommodation', label: 'Lodging / Accommodation', count: stayCount, icon: <Home size={22} strokeWidth={2.1} />, tone: 'stay' },
    { key: 'rental-car', label: 'Rental car', count: rentalCarCount, icon: <CarFront size={22} strokeWidth={2.1} />, tone: 'car' },
    { key: 'attachments', label: 'Attachments', count: attachmentCount, icon: <Paperclip size={22} strokeWidth={2.1} />, tone: 'attachment' },
    { key: 'other', label: 'Other', count: otherCount, icon: <MoreHorizontal size={22} strokeWidth={2.1} />, tone: 'other' },
  ];

  return (
    <div className="trip-overview-page">
      <div className="trip-overview-bg" aria-hidden="true">
        <div className="aurora-orb aurora-orb--1" />
        <div className="aurora-orb aurora-orb--2" />
        <div className="aurora-orb aurora-orb--3" />
      </div>

      <aside className="trip-overview-sidebar">
        <div className="trip-overview-sidebar-brand">
          <div className="trip-overview-sidebar-brand-mark">
            <Plane size={18} strokeWidth={2.2} />
          </div>
          <div>
            <div className="trip-overview-sidebar-brand-title">TripWiz</div>
            <div className="trip-overview-sidebar-brand-sub">Travel dashboard</div>
          </div>
        </div>

        <nav className="trip-overview-nav">
          {SECTION_ORDER.map((section) => {
            const Icon = section.icon;
            return (
            <button key={section.id} className={sectionButtonClass(activeSection, section.id)} onClick={() => scrollToSection(section.id)} type="button">
              <span className="overview-nav-link-icon"><Icon size={16} strokeWidth={2.15} /></span>
              <span className="overview-nav-link-label">{section.label}</span>
              <ChevronRight className="overview-nav-link-arrow" size={14} strokeWidth={2.2} />
            </button>
            );
          })}
        </nav>

        <div className="trip-overview-sidebar-actions">
          <button className="overview-sidebar-btn" onClick={() => navigate('/trips')} type="button">
            <ArrowLeft size={14} strokeWidth={2.5} /> Trips
          </button>
          <button className="overview-sidebar-btn overview-sidebar-btn--primary" onClick={() => navigate(`/trips/${tripId}`)} type="button">
            <MapPin size={14} strokeWidth={2.35} /> Open planner
          </button>
        </div>
      </aside>

      <main className="trip-overview-main">
        <header className="trip-overview-hero">
          <div className="trip-overview-hero-card">
            <div className="trip-overview-hero-media" aria-hidden="true">
              {heroSlides.length > 0 && heroSlides.map((src, index) => (
                <img
                  key={`${src}-${index}`}
                  src={src}
                  alt=""
                  className={`trip-overview-hero-slide${index === (heroIndex % heroSlides.length) ? ' trip-overview-hero-slide--active' : ''}`}
                />
              ))}
              {!currentHero && <div className="trip-overview-hero-cover-fallback" />}
              <div className="trip-overview-hero-media-overlay" />
            </div>
            <div className="trip-overview-hero-top">
              <div>
                <div className="trip-overview-kicker">Trip overview</div>
                <h1>{trip.title || 'Untitled Trip'}</h1>
                <div className="trip-overview-dates">
                  <Calendar size={14} strokeWidth={2.2} />
                  <span>{formatDateRange(trip.startDate, trip.endDate)}</span>
                </div>
              </div>

              <div className="trip-overview-save-status">
                <span className={`trip-overview-save-dot trip-overview-save-dot--${saveStatus}`} />
                {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'unsaved' ? 'Unsaved' : 'Saved'}
              </div>
            </div>

            <div className="trip-overview-stats">
              <div className="trip-overview-stat"><strong>{totalStops}</strong><span>Stops</span></div>
              <div className="trip-overview-stat"><strong>{flightCount}</strong><span>Flights</span></div>
              <div className="trip-overview-stat"><strong>{stayCount}</strong><span>Stays</span></div>
              <div className="trip-overview-stat"><strong>{selectedPackingCount}</strong><span>Packed</span></div>
            </div>

            <div className="trip-overview-hero-actions">
              <button className="overview-hero-btn overview-hero-btn--primary" onClick={() => navigate(`/trips/${tripId}`)} type="button">
                Add places to route
              </button>
              <button className="overview-hero-btn" onClick={() => scrollToSection('export')} type="button">
                <Download size={14} strokeWidth={2.2} /> Export
              </button>
              <button className="overview-hero-btn" onClick={() => scrollToSection('itinerary')} type="button">
                <ChevronRight size={14} strokeWidth={2.2} /> View itinerary
              </button>
            </div>
          </div>
        </header>

        {error && (
          <div className="error-banner overview-banner">
            {error}
            <button onClick={() => setError('')} type="button">×</button>
          </div>
        )}

        <SectionShell id="overview" title="Reservations and attachments" subtitle="Track the key trip pieces at a glance" sectionRef={(node) => { sectionRefs.current.overview = node; }}>
          <div className="overview-card overview-reservations-card">
            <div className="overview-reservations-header">
              <div className="overview-reservations-header-icon">
                <Package size={20} strokeWidth={2.1} />
              </div>
              <div>
                <div className="overview-card-title">Reservations and attachments</div>
                <p className="overview-note-text">A live summary of the trip items you have already added.</p>
              </div>
            </div>

            <div className="overview-reservations-grid">
              {reservationSummaryItems.map((item) => (
                <div key={item.key} className={`overview-reservation-tile overview-reservation-tile--${item.tone}`}>
                  <div className="overview-reservation-tile-icon">{item.icon}</div>
                  <div className="overview-reservation-tile-content">
                    <div className="overview-reservation-count">{item.count}</div>
                    <div className="overview-reservation-label">{item.label}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </SectionShell>

        <SectionShell id="flights" title="Flights" subtitle="Store departure and arrival details in one place" sectionRef={(node) => { sectionRefs.current.flights = node; }}>
          <div className="overview-toolbar">
            <button className="overview-toolbar-btn" onClick={() => openFlightModal()} type="button"><span className="overview-toolbar-emoji">✈️</span> Add flight</button>
          </div>
          <div className="overview-cards-grid">
            {dashboard.flights.length === 0 ? (
              <div className="overview-empty-card overview-flight-empty">
                <div className="overview-flight-empty-emoji">✈️</div>
                <div className="overview-card-title">No flights added yet</div>
                <p className="overview-note-text">Add flight segments here so the trip overview stays connected to your itinerary.</p>
                <button className="overview-toolbar-btn" onClick={() => openFlightModal()} type="button">Add first flight</button>
              </div>
            ) : dashboard.flights.map((flight) => (
              <div key={flight.id} className="overview-card overview-flight-card">
                <div className="overview-flight-card-top">
                  <div className="overview-flight-badge">✈️ Flight</div>
                  <div className={`overview-flight-status ${flight.status ? 'overview-flight-status--named' : ''}`}>
                    {flightStatusLabel(flight.status)}
                  </div>
                </div>

                <div className="overview-flight-route">{flightRouteLabel(flight)}</div>
                <div className="overview-card-subtitle overview-flight-detail">
                  {flightRouteDetail(flight, 'from') || 'Origin'} → {flightRouteDetail(flight, 'to') || 'Destination'}
                </div>
                <div className="overview-card-subtitle overview-flight-airline">
                  {flight.airline || 'Airline'}{flight.flightNumber ? ` · ${flight.flightNumber}` : ''}
                </div>

                <div className="overview-flight-legs">
                  <div className="overview-flight-leg">
                    <div className="overview-flight-leg-title">Departure</div>
                    <div className="overview-flight-leg-grid">
                      <div className="overview-flight-leg-time">
                        <span>Time</span>
                        <strong>{flightDisplayValue(flight.departureTime)}</strong>
                      </div>
                      <div className="overview-flight-leg-airport">
                        <span>Airport</span>
                        <strong>{flightAirportLabel(flight, 'departure').primary}</strong>
                        {flightAirportLabel(flight, 'departure').secondary && <small>{flightAirportLabel(flight, 'departure').secondary}</small>}
                      </div>
                      <div className="overview-flight-leg-meta">
                        <span>Terminal</span>
                        <strong>{flightDisplayValue(flight.departureTerminal)}</strong>
                      </div>
                      <div className="overview-flight-leg-meta">
                        <span>Gate</span>
                        <strong>{flightDisplayValue(flight.departureGate)}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="overview-flight-connector" aria-hidden="true">
                    <div className="overview-flight-connector-line"></div>
                    <span className="overview-flight-connector-plane">
                      <Plane className="overview-flight-connector-plane-icon" size={18} />
                    </span>
                  </div>

                  <div className="overview-flight-leg">
                    <div className="overview-flight-leg-title">Arrival</div>
                    <div className="overview-flight-leg-grid">
                      <div className="overview-flight-leg-time">
                        <span>Time</span>
                        <strong>{flightDisplayValue(flight.arrivalTime)}</strong>
                      </div>
                      <div className="overview-flight-leg-airport">
                        <span>Airport</span>
                        <strong>{flightAirportLabel(flight, 'arrival').primary}</strong>
                        {flightAirportLabel(flight, 'arrival').secondary && <small>{flightAirportLabel(flight, 'arrival').secondary}</small>}
                      </div>
                      <div className="overview-flight-leg-meta">
                        <span>Terminal</span>
                        <strong>{flightDisplayValue(flight.arrivalTerminal)}</strong>
                      </div>
                      <div className="overview-flight-leg-meta">
                        <span>Gate</span>
                        <strong>{flightDisplayValue(flight.arrivalGate)}</strong>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="overview-card-row overview-flight-meta-row">
                  <span className="overview-flight-meta-chip"><Calendar size={12} strokeWidth={2} /> {formatPdfDate(flight.date)}</span>
                  {flight.price ? <span className="overview-flight-meta-chip overview-flight-meta-chip--accent">{flight.price}</span> : <span className="overview-flight-meta-chip">No price added</span>}
                  <div className="overview-card-actions">
                    <button className="overview-icon-btn" onClick={() => openFlightModal(flight)} type="button"><Pencil size={14} strokeWidth={2.2} /></button>
                    <button className="overview-icon-btn overview-icon-btn--danger" onClick={() => removeFlight(flight.id)} type="button"><Trash2 size={14} strokeWidth={2.2} /></button>
                  </div>
                </div>
                <div className="overview-micro-grid">
                  <div><label>Price</label><strong>{flight.price || '—'}</strong></div>
                  <div><label>Status</label><strong>{flight.status || '—'}</strong></div>
                </div>
                {flight.notes && <p className="overview-note-text">{flight.notes}</p>}
              </div>
            ))}
          </div>
        </SectionShell>

        <SectionShell id="accommodation" title="Accommodation" subtitle="Hotels, apartments, cabins and other stays" sectionRef={(node) => { sectionRefs.current.accommodation = node; }}>
          <div className="overview-accommodation-shell">
            <div className="overview-accommodation-decor overview-accommodation-decor--palm" aria-hidden="true" />
            <div className="overview-accommodation-decor overview-accommodation-decor--suitcase" aria-hidden="true" />
            <div className="overview-accommodation-decor overview-accommodation-decor--plane" aria-hidden="true" />

            <div className="overview-accommodation-header">
              <div className="overview-accommodation-heading">
                <span className="overview-accommodation-heading-icon" aria-hidden="true"><BedDouble size={19} strokeWidth={2.1} /></span>
                <div>
                  <div className="overview-accommodation-kicker">Stay planning</div>
                  <div className="overview-accommodation-title">Accommodation</div>
                  <p>Hotels, apartments, cabins and other stays</p>
                </div>
              </div>
              <button className="overview-toolbar-btn overview-accommodation-add-btn" onClick={() => openStayModal()} type="button">
                <Plus size={14} strokeWidth={2.2} /> Add accommodation
              </button>
            </div>

            <div className="overview-cards-grid overview-cards-grid--accommodation">
            {dashboard.accommodations.length === 0 ? (
              <div className="overview-empty-card">No accommodation added yet.</div>
            ) : dashboard.accommodations.map((stay) => (
              <div key={stay.id} className="overview-card overview-stay-card">
                <div className="overview-stay-art" aria-hidden="true">
                  <div className="overview-stay-art-badge">Stay</div>
                  <div className="overview-stay-art-icon"><BedDouble size={24} strokeWidth={2.1} /></div>
                  <div className="overview-stay-art-spark overview-stay-art-spark--1" />
                  <div className="overview-stay-art-spark overview-stay-art-spark--2" />
                </div>

                <div className="overview-stay-content">
                  <div className="overview-stay-heading">
                    <div className="overview-card-title overview-stay-title">{stay.name || 'Accommodation'}</div>
                    <div className="overview-card-subtitle overview-stay-type"><Home size={13} strokeWidth={2.1} /> {formatAccommodationType(stay.type)}</div>
                  </div>

                  <div className="overview-meta-row overview-stay-meta-row">
                    <span><Calendar size={13} strokeWidth={2} /> <strong>Check-in</strong> {formatDisplayDate(stay.checkIn) || 'Not set'}</span>
                    <span><Calendar size={13} strokeWidth={2} /> <strong>Check-out</strong> {formatDisplayDate(stay.checkOut) || 'Not set'}</span>
                  </div>
                  <p className="overview-note-text overview-stay-address"><MapPin size={13} strokeWidth={2} /> {stay.address || 'No address added'}</p>
                  <p className="overview-note-text overview-stay-notes"><FileText size={13} strokeWidth={2} /> {stay.notes || 'No notes added yet.'}</p>
                </div>

                <div className="overview-card-actions overview-stay-actions">
                  <button className="overview-icon-btn" onClick={() => openStayModal(stay)} type="button" aria-label="Edit accommodation"><Pencil size={14} strokeWidth={2.2} /></button>
                  <button className="overview-icon-btn overview-icon-btn--danger" onClick={() => removeStay(stay.id)} type="button" aria-label="Delete accommodation"><Trash2 size={14} strokeWidth={2.2} /></button>
                </div>
              </div>
            ))}
            </div>
          </div>
        </SectionShell>

        <SectionShell id="rental-car" title="Rental Car" subtitle="Track rental pickups and returns alongside the rest of the trip" sectionRef={(node) => { sectionRefs.current.rentalCar = node; }}>
          <div className="overview-toolbar">
            <button className="overview-toolbar-btn" onClick={() => openRentalCarModal()} type="button"><CarFront size={14} strokeWidth={2.2} /> Add rental car</button>
          </div>
          <div className="overview-cards-grid overview-cards-grid--rental">
            {dashboard.rentalCars.length === 0 ? (
              <div className="overview-empty-card">No rental cars added yet.</div>
            ) : dashboard.rentalCars.map((car) => (
              <div key={car.id} className="overview-card overview-rental-card">
                <div className="overview-rental-art" aria-hidden="true">
                  <div className="overview-stay-art-badge">Car</div>
                  <div className="overview-rental-art-icon"><CarFront size={24} strokeWidth={2.1} /></div>
                  <div className="overview-rental-art-line" />
                </div>

                <div className="overview-rental-content">
                  <div className="overview-card-row overview-rental-card-row">
                    <div className="overview-rental-heading">
                      <div className="overview-card-title overview-rental-title">{car.company || 'Rental car'}</div>
                      <div className="overview-card-subtitle overview-rental-type">{car.carType || 'Car type not set'}</div>
                    </div>
                    <div className="overview-card-actions">
                      <button className="overview-icon-btn" onClick={() => openRentalCarModal(car)} type="button"><Pencil size={14} strokeWidth={2.2} /></button>
                      <button className="overview-icon-btn overview-icon-btn--danger" onClick={() => removeRentalCar(car.id)} type="button"><Trash2 size={14} strokeWidth={2.2} /></button>
                    </div>
                  </div>

                  <div className="overview-rental-grid">
                    <div className="overview-rental-meta">
                      <span>Pickup</span>
                      <strong>{car.pickupLocation || '—'}</strong>
                      <small>{formatDisplayDate(car.pickupDate)} {car.pickupTime ? `· ${car.pickupTime}` : ''}</small>
                    </div>
                    <div className="overview-rental-meta">
                      <span>Return</span>
                      <strong>{car.returnLocation || '—'}</strong>
                      <small>{formatDisplayDate(car.returnDate)} {car.returnTime ? `· ${car.returnTime}` : ''}</small>
                    </div>
                    <div className="overview-rental-meta">
                      <span>Confirmation</span>
                      <strong>{car.confirmationNumber || '—'}</strong>
                      <small>{car.price || 'No price added'}</small>
                    </div>
                  </div>

                  {car.notes && <p className="overview-note-text overview-rental-notes">{car.notes}</p>}
                </div>
              </div>
            ))}
          </div>
        </SectionShell>

        <SectionShell id="documents" title="Trip Documents" subtitle="General files connected to the whole trip" sectionRef={(node) => { sectionRefs.current.documents = node; }}>
          <div className="overview-documents-panel">
            <AttachmentManager
              title="Trip documents"
              canUpload
              attachments={attachmentsFor('general')}
              dashboard={dashboard}
              attachmentStatus={attachmentStatus}
              statusKey="general:general:upload"
              onUpload={(file) => uploadAttachment(file, 'general', null)}
              onOpen={openAttachment}
              onDelete={deleteAttachment}
            />
            {attachmentsLoading && (
              <div className="overview-attachment-status">
                <Loader2 className="overview-spin" size={14} /> Loading documents...
              </div>
            )}
            <div className="overview-all-documents">
              <div className="overview-attachments-title">All uploaded files</div>
              <AttachmentList
                attachments={attachments}
                dashboard={dashboard}
                attachmentStatus={attachmentStatus}
                onOpen={openAttachment}
                onDelete={deleteAttachment}
              />
            </div>
          </div>
        </SectionShell>

        <SectionShell id="itinerary" title="Daily itinerary" subtitle="Add notes for every stop without leaving this overview" sectionRef={(node) => { sectionRefs.current.itinerary = node; }}>
          <div className="overview-itinerary-list">
            {itineraryGroups.length === 0 ? (
              <div className="overview-empty-card">Add places in the planner to see the itinerary here.</div>
            ) : itineraryGroups.map((group) => (
              <div key={group.dayIndex} className="overview-day-group">
                <div className="overview-day-title">{dayLabel(trip, group.dayIndex)}</div>
                <div className="overview-day-subtitle">{group.items.length} stops</div>
                <div className="overview-day-stops">
                  {group.items.map((stop) => (
                    <div key={stop.slotId} className="overview-stop-card">
                      <div className="overview-card-row">
                        <div>
                          <div className="overview-card-title">{stop.title || 'Stop'}</div>
                          <div className="overview-card-subtitle">{stop.start ? formatTime(stop.start) : 'No time set'}</div>
                        </div>
                        <button className="overview-inline-btn overview-inline-btn--small" onClick={() => removeStopNote(stop.slotId)} type="button">Clear note</button>
                      </div>
                      <textarea
                        className="overview-stop-note-input"
                        rows={3}
                        value={noteDrafts[stop.slotId] ?? dashboard.stopNotes[stop.slotId] ?? ''}
                        onChange={(e) => setNoteDrafts((prev) => ({ ...prev, [stop.slotId]: e.target.value }))}
                        placeholder="Hours, reminder, booking info, what to bring..."
                      />
                      <div className="overview-inline-actions">
                        <button className="overview-toolbar-btn" onClick={() => saveStopNote(stop.slotId)} type="button"><Save size={14} strokeWidth={2.2} /> Save note</button>
                        {weather[stop.slotId] && (
                          <span className={`overview-weather-pill${weather[stop.slotId].isAlert ? ' overview-weather-pill--alert' : ''}`}>
                            {weather[stop.slotId].condition || 'Weather'} · {weather[stop.slotId].tempC}°C
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SectionShell>

        <SectionShell id="notes" title="Notes" subtitle="Keep general trip notes and stop notes together" sectionRef={(node) => { sectionRefs.current.notes = node; }}>
          <div className="overview-notes-grid">
            <div className="overview-card">
              <div className="overview-card-title">General trip notes</div>
              <textarea
                className="overview-general-note-input"
                rows={7}
                value={generalNotesDraft}
                onChange={(e) => setGeneralNotesDraft(e.target.value)}
                placeholder="Booking confirmations, key reminders, packing reminders, and anything else you want to keep with the trip."
              />
              <button className="overview-toolbar-btn" onClick={saveGeneralNotes} type="button"><Save size={14} strokeWidth={2.2} /> Save trip notes</button>
            </div>

            <div className="overview-card">
              <div className="overview-card-title">Stop note index</div>
              <div className="overview-note-index">
                {(trip.itinerary || []).length === 0 ? (
                  <div className="overview-empty-text">No stops yet.</div>
                ) : (trip.itinerary || []).map((stop) => (
                  <div key={stop.slotId} className="overview-note-index-row">
                    <strong>{stop.title || 'Stop'}</strong>
                    <span>{dashboard.stopNotes[stop.slotId] || 'No note added yet'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </SectionShell>

        <SectionShell id="packing" title="Packing list" subtitle="Categories and checklist items for the whole trip" sectionRef={(node) => { sectionRefs.current.packing = node; }}>
          <div className="overview-packing-shell">
            <div className="overview-packing-decor overview-packing-decor--suitcase" aria-hidden="true" />
            <div className="overview-packing-decor overview-packing-decor--palm" aria-hidden="true" />
            <div className="overview-packing-decor overview-packing-decor--plane" aria-hidden="true" />

            <div className="overview-packing-layout">
              <aside className="overview-packing-sidebar">
                <div className="overview-packing-sidebar-header">
                  <div>
                    <div className="overview-card-title">Categories</div>
                    <p className="overview-note-text">Choose a category to edit its checklist.</p>
                  </div>
                  <div className="overview-packing-sidebar-count">{dashboard.packingCategories.length}</div>
                </div>

                <div className="overview-packing-add-row">
                  <input
                    className="overview-mini-input"
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    placeholder="Add new category"
                  />
                  <button className="overview-toolbar-btn" onClick={addCategory} type="button"><Plus size={14} strokeWidth={2.2} /> Add</button>
                </div>

                <div className="overview-packing-category-list">
                  {dashboard.packingCategories.map((category) => {
                    const packedCount = category.items.filter((item) => item.checked).length;
                    const progress = category.items.length > 0 ? Math.round((packedCount / category.items.length) * 100) : 0;
                    const active = selectedPackingCategory?.id === category.id;

                    return (
                      <button
                        key={category.id}
                        type="button"
                        className={active ? 'overview-packing-category-card overview-packing-category-card--active' : 'overview-packing-category-card'}
                        onClick={() => setSelectedPackingCategoryId(category.id)}
                      >
                        <div className="overview-packing-category-card-top">
                          <div>
                            <div className="overview-packing-category-title">{category.name}</div>
                            <div className="overview-packing-category-subtitle">{packedCount} of {category.items.length} packed</div>
                          </div>
                          <div className="overview-packing-category-count">{category.items.length}</div>
                        </div>
                        <div className="overview-packing-category-progress">
                          <span style={{ width: `${progress}%` }} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </aside>

              <div className="overview-packing-detail">
                {selectedPackingCategory ? (
                  <div className="overview-card overview-packing-detail-card">
                    <div className="overview-packing-detail-header">
                      <div className="overview-packing-detail-title-wrap">
                        <div className="overview-packing-detail-icon">🧳</div>
                        <div>
                          {packingEdit && packingEdit.type === 'category' && packingEdit.categoryId === selectedPackingCategory.id ? (
                            <input
                              className="overview-mini-input"
                              value={packingEdit.label}
                              onChange={(e) => setPackingEdit((current) => current ? { ...current, label: e.target.value } : current)}
                            />
                          ) : (
                            <div className="overview-packing-detail-title">{selectedPackingCategory.name}</div>
                          )}
                          <div className="overview-packing-detail-subtitle">{selectedPackingDone} of {selectedPackingTotal} packed</div>
                        </div>
                      </div>
                      <div className="overview-card-actions">
                        <button className="overview-icon-btn" onClick={() => toggleCategoryEdit(selectedPackingCategory.id, selectedPackingCategory.name)} type="button"><Pencil size={14} strokeWidth={2.2} /></button>
                        {packingEdit && packingEdit.type === 'category' && packingEdit.categoryId === selectedPackingCategory.id ? (
                          <button className="overview-icon-btn" onClick={saveCategoryEdit} type="button"><Check size={14} strokeWidth={2.2} /></button>
                        ) : null}
                        <button className="overview-icon-btn overview-icon-btn--danger" onClick={() => deletePackingCategory(selectedPackingCategory.id)} type="button"><Trash2 size={14} strokeWidth={2.2} /></button>
                      </div>
                    </div>

                    <div className="overview-packing-progress-block">
                      <div className="overview-packing-progress-labels">
                        <span>Progress</span>
                        <strong>{selectedPackingProgress}%</strong>
                      </div>
                      <div className="overview-packing-progress-bar">
                        <span style={{ width: `${selectedPackingProgress}%` }} />
                      </div>
                    </div>

                    <div className="overview-packing-add-item-row">
                      <input
                        className="overview-mini-input"
                        value={categoryItemDrafts[selectedPackingCategory.id] || ''}
                        onChange={(e) => setCategoryItemDrafts((prev) => ({ ...prev, [selectedPackingCategory.id]: e.target.value }))}
                        placeholder={`Add item to ${selectedPackingCategory.name}`}
                      />
                      <button className="overview-inline-btn overview-inline-btn--small" onClick={() => addPackingItem(selectedPackingCategory.id)} type="button">Add item</button>
                    </div>

                    <div className="overview-packing-items overview-packing-items--detail">
                      {selectedPackingCategory.items.length === 0 ? (
                        <div className="overview-empty-text">No items yet.</div>
                      ) : selectedPackingCategory.items.map((item) => (
                        <div key={item.id} className="overview-packing-item overview-packing-item--detail">
                          <label className="overview-packing-check">
                            <input type="checkbox" checked={item.checked} onChange={() => togglePackingItem(selectedPackingCategory.id, item.id)} />
                            <span className={item.checked ? 'overview-packing-item-label overview-packing-item-label--done' : 'overview-packing-item-label'}>
                              {item.label}
                            </span>
                          </label>
                          <div className="overview-card-actions">
                            <button className="overview-icon-btn" onClick={() => setPackingEdit({ type: 'item', categoryId: selectedPackingCategory.id, itemId: item.id, label: item.label })} type="button"><Pencil size={14} strokeWidth={2.2} /></button>
                            <button className="overview-icon-btn overview-icon-btn--danger" onClick={() => deletePackingItem(selectedPackingCategory.id, item.id)} type="button"><Trash2 size={14} strokeWidth={2.2} /></button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="overview-card overview-packing-detail-card overview-packing-detail-card--empty">
                    <div className="overview-card-title">No categories yet</div>
                    <p className="overview-note-text">Add your first packing category to start building the checklist.</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {packingEdit && packingEdit.type === 'item' && (
            <ModalShell
              title="Edit packing item"
              onClose={() => setPackingEdit(null)}
              footer={(
                <>
                  <button className="overview-modal-secondary" onClick={() => setPackingEdit(null)} type="button">Cancel</button>
                  <button className="overview-modal-primary" onClick={() => {
                    const label = packingEdit.label.trim();
                    if (!label) return;
                    const next = dashboard.packingCategories.map((category) => {
                      if (category.id !== packingEdit.categoryId) return category;
                      return {
                        ...category,
                        items: category.items.map((item) => (item.id === packingEdit.itemId ? { ...item, label } : item)),
                      };
                    });
                    updatePackingCategories(next);
                    setPackingEdit(null);
                  }} type="button">Save changes</button>
                </>
              )}
            >
              <input
                className="trips-modal-input"
                value={packingEdit.label}
                onChange={(e) => setPackingEdit((current) => current ? { ...current, label: e.target.value } : current)}
              />
            </ModalShell>
          )}
        </SectionShell>

        <SectionShell id="export" title="Export" subtitle="Choose exactly which sections to include" sectionRef={(node) => { sectionRefs.current.export = node; }}>
          <div className="overview-export-card">
            <div className="overview-card-title">Export your trip dashboard</div>
            <p className="overview-note-text">Select one or more sections, then export to Excel or PDF.</p>
            <button className="overview-toolbar-btn" onClick={() => { prepareExportSelection(true); setShowExportModal(true); }} type="button">
              <Download size={14} strokeWidth={2.2} /> Open export options
            </button>
          </div>
        </SectionShell>
      </main>

      {flightModal && (
        <FlightModal
          flight={flightModal}
          trip={trip}
          dashboard={dashboard}
          canUpload
          attachments={attachmentsFor('flight', flightModal.id)}
          attachmentStatus={attachmentStatus}
          onUploadAttachment={(file) => uploadAttachment(file, 'flight', flightModal.id)}
          onOpenAttachment={openAttachment}
          onDeleteAttachment={deleteAttachment}
          onClose={() => setFlightModal(null)}
          onSave={saveFlightFlight}
        />
      )}

      {stayModal && (
        <StayModal
          stay={stayModal}
          dashboard={dashboard}
          canUpload
          attachments={attachmentsFor('accommodation', stayModal.id)}
          attachmentStatus={attachmentStatus}
          onUploadAttachment={(file) => uploadAttachment(file, 'accommodation', stayModal.id)}
          onOpenAttachment={openAttachment}
          onDeleteAttachment={deleteAttachment}
          onClose={() => setStayModal(null)}
          onSave={saveStayDraft}
        />
      )}

      {rentalCarModal && (
        <RentalCarModal
          rentalCar={rentalCarModal}
          dashboard={dashboard}
          canUpload
          attachments={attachmentsFor('rentalCar', rentalCarModal.id)}
          attachmentStatus={attachmentStatus}
          onUploadAttachment={(file) => uploadAttachment(file, 'rentalCar', rentalCarModal.id)}
          onOpenAttachment={openAttachment}
          onDeleteAttachment={deleteAttachment}
          onClose={() => setRentalCarModal(null)}
          onSave={saveRentalCarDraft}
        />
      )}

      {showExportModal && (
        <ExportModal
          selection={exportSelection}
          format={exportFormat}
          onToggleSelection={(key) => setExportSelection((current) => ({ ...current, [key]: !current[key] }))}
          onChangeFormat={setExportFormat}
          onClose={() => setShowExportModal(false)}
          onExport={runExport}
        />
      )}
    </div>
  );
}

function AttachmentList({ attachments, dashboard, attachmentStatus, onOpen, onDelete, compact = false }) {
  if (!attachments.length) {
    return <div className="overview-attachments-empty">{compact ? 'No documents attached.' : 'No trip documents uploaded yet.'}</div>;
  }
  return (
    <div className={`overview-attachments-list${compact ? ' overview-attachments-list--compact' : ''}`}>
      {attachments.map((attachment) => {
        const openStatus = attachmentStatus[`${attachment.fileId}:open`];
        const deleteStatus = attachmentStatus[`${attachment.fileId}:delete`];
        const busy = openStatus?.state === 'loading' || deleteStatus?.state === 'loading';
        const error = openStatus?.state === 'error' ? openStatus.message : deleteStatus?.state === 'error' ? deleteStatus.message : '';
        return (
          <div key={attachment.fileId} className="overview-attachment-row">
            <div className="overview-attachment-icon"><FileText size={16} strokeWidth={2.1} /></div>
            <div className="overview-attachment-main">
              <div className="overview-attachment-name">{attachment.fileName}</div>
              <div className="overview-attachment-meta">
                <span>{formatFileSize(attachment.fileSize)}</span>
                <span>{formatDisplayDate(attachment.uploadedAt) || 'Uploaded'}</span>
                <span>{relatedItemLabel(attachment, dashboard)}</span>
              </div>
              {error && <div className="overview-attachment-status overview-attachment-status--error">{error}</div>}
            </div>
            <div className="overview-attachment-actions">
              <button className="overview-icon-btn" onClick={() => onOpen(attachment)} disabled={busy} type="button" aria-label={`Open ${attachment.fileName}`}>
                {openStatus?.state === 'loading' ? <Loader2 className="overview-spin" size={14} /> : <ExternalLink size={14} strokeWidth={2.2} />}
              </button>
              <button className="overview-icon-btn overview-icon-btn--danger" onClick={() => onDelete(attachment)} disabled={busy} type="button" aria-label={`Delete ${attachment.fileName}`}>
                {deleteStatus?.state === 'loading' ? <Loader2 className="overview-spin" size={14} /> : <Trash2 size={14} strokeWidth={2.2} />}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AttachmentManager({
  title = 'Documents',
  canUpload = true,
  attachments,
  dashboard,
  attachmentStatus,
  statusKey,
  onUpload,
  onOpen,
  onDelete,
  compact = false,
}) {
  const fileInputRef = useRef(null);
  const uploadStatus = attachmentStatus[statusKey];

  function selectFile(event) {
    const file = event.target.files?.[0];
    if (file) onUpload(file);
    event.target.value = '';
  }

  return (
    <div className={`overview-attachments${compact ? ' overview-attachments--compact' : ''}`}>
      <div className="overview-attachments-header">
        <div>
          <div className="overview-attachments-title">{title}</div>
          <div className="overview-attachments-helper">PDF, images, or DOCX up to 10 MB</div>
        </div>
        <input ref={fileInputRef} className="overview-file-input" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,application/pdf,image/png,image/jpeg,image/webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={selectFile} />
        <button className="overview-toolbar-btn overview-attachment-upload-btn" onClick={() => fileInputRef.current?.click()} disabled={!canUpload || uploadStatus?.state === 'loading'} type="button">
          {uploadStatus?.state === 'loading' ? <Loader2 className="overview-spin" size={14} /> : <UploadCloud size={14} strokeWidth={2.2} />}
          Upload
        </button>
      </div>
      {!canUpload && <div className="overview-attachment-status">Save this item before uploading documents.</div>}
      {uploadStatus?.state === 'success' && <div className="overview-attachment-status overview-attachment-status--success">{uploadStatus.message}</div>}
      {uploadStatus?.state === 'error' && <div className="overview-attachment-status overview-attachment-status--error">{uploadStatus.message}</div>}
      <AttachmentList
        attachments={attachments}
        dashboard={dashboard}
        attachmentStatus={attachmentStatus}
        onOpen={onOpen}
        onDelete={onDelete}
        compact={compact}
      />
    </div>
  );
}

function FlightModal({ flight, trip, dashboard, canUpload, attachments, attachmentStatus, onUploadAttachment, onOpenAttachment, onDeleteAttachment, onClose, onSave }) {
  const [draft, setDraft] = useState(flight);
  const { min: tripMinDate, max: tripMaxDate } = tripDateBounds(trip);
  const dateInRange = isFlightDateWithinTrip(draft.date, trip);

  return (
    <ModalShell
      title={flight.id ? 'Flight details' : 'Add flight'}
      subtitle="Keep the essentials in one place — route, timing, airline, and status."
      onClose={onClose}
      className="overview-modal--compact overview-modal--flight"
      footer={(
        <>
          <button className="overview-modal-secondary" onClick={onClose} type="button">Cancel</button>
          <button className="overview-modal-primary" onClick={() => onSave(draft)} disabled={!dateInRange} type="button">Save flight</button>
        </>
      )}
    >
      <div className="overview-modal-grid">
        <div className="overview-modal-flight-section overview-modal-field--full">
          <div className="overview-modal-flight-section-title">Departure</div>
          <PlaceAutocompleteField
            label="Airport"
            value={draft.from}
            placeholder="Airport or country"
            onChange={(next) => setDraft((current) => ({ ...current, from: next, fromCountry: '', fromAirport: '', fromIata: '' }))}
            onSelectPlace={(place) => setDraft((current) => ({
              ...current,
              from: place.label,
              fromCountry: place.country || '',
              fromAirport: place.airportName || '',
              fromIata: place.iata || '',
            }))}
          />
          <div className="overview-modal-flight-mini-grid">
            <label className="overview-modal-field">
              <span>Time</span>
              <input className="trips-modal-input" type="time" value={draft.departureTime} onChange={(e) => setDraft((current) => ({ ...current, departureTime: e.target.value }))} />
            </label>
            <label className="overview-modal-field">
              <span>Terminal</span>
              <input className="trips-modal-input" value={draft.departureTerminal} onChange={(e) => setDraft((current) => ({ ...current, departureTerminal: e.target.value }))} />
            </label>
            <label className="overview-modal-field">
              <span>Gate</span>
              <input className="trips-modal-input" value={draft.departureGate} onChange={(e) => setDraft((current) => ({ ...current, departureGate: e.target.value }))} />
            </label>
          </div>
        </div>

        <div className="overview-modal-flight-section overview-modal-field--full">
          <div className="overview-modal-flight-section-title">Arrival</div>
          <PlaceAutocompleteField
            label="Airport"
            value={draft.to}
            placeholder="Airport or country"
            onChange={(next) => setDraft((current) => ({ ...current, to: next, toCountry: '', toAirport: '', toIata: '' }))}
            onSelectPlace={(place) => setDraft((current) => ({
              ...current,
              to: place.label,
              toCountry: place.country || '',
              toAirport: place.airportName || '',
              toIata: place.iata || '',
            }))}
          />
          <div className="overview-modal-flight-mini-grid">
            <label className="overview-modal-field">
              <span>Time</span>
              <input className="trips-modal-input" type="time" value={draft.arrivalTime} onChange={(e) => setDraft((current) => ({ ...current, arrivalTime: e.target.value }))} />
            </label>
            <label className="overview-modal-field">
              <span>Terminal</span>
              <input className="trips-modal-input" value={draft.arrivalTerminal} onChange={(e) => setDraft((current) => ({ ...current, arrivalTerminal: e.target.value }))} />
            </label>
            <label className="overview-modal-field">
              <span>Gate</span>
              <input className="trips-modal-input" value={draft.arrivalGate} onChange={(e) => setDraft((current) => ({ ...current, arrivalGate: e.target.value }))} />
            </label>
          </div>
        </div>

        <label className="overview-modal-field">
          <span>date</span>
          <input
            className="trips-modal-input"
            type="date"
            min={tripMinDate || undefined}
            max={tripMaxDate || undefined}
            value={draft.date}
            onChange={(e) => setDraft((current) => ({ ...current, date: e.target.value }))}
          />
          {!dateInRange && (
            <span className="overview-field-error">
              {tripMaxDate && tripMaxDate !== tripMinDate
                ? `Must be between ${formatDisplayDate(tripMinDate)} and ${formatDisplayDate(tripMaxDate)} (the trip's dates).`
                : `Must match the trip's date (${formatDisplayDate(tripMinDate)}).`}
            </span>
          )}
        </label>
        {['airline', 'flightNumber', 'price', 'status'].map((field) => (
          <label key={field} className="overview-modal-field">
            <span>{field}</span>
            <input
              className="trips-modal-input"
              type="text"
              value={draft[field]}
              onChange={(e) => setDraft((current) => ({ ...current, [field]: e.target.value }))}
            />
          </label>
        ))}
        <label className="overview-modal-field overview-modal-field--full">
          <span>Notes</span>
          <textarea
            className="trips-modal-input"
            rows={3}
            value={draft.notes}
            onChange={(e) => setDraft((current) => ({ ...current, notes: e.target.value }))}
          />
        </label>
        <div className="overview-modal-field--full">
          <AttachmentManager
            title="Flight documents"
            canUpload={canUpload}
            attachments={attachments}
            dashboard={dashboard}
            attachmentStatus={attachmentStatus}
            statusKey={`flight:${flight.id}:upload`}
            onUpload={onUploadAttachment}
            onOpen={onOpenAttachment}
            onDelete={onDeleteAttachment}
            compact
          />
        </div>
      </div>
    </ModalShell>
  );
}

function StayModal({ stay, dashboard, canUpload, attachments, attachmentStatus, onUploadAttachment, onOpenAttachment, onDeleteAttachment, onClose, onSave }) {
  const [draft, setDraft] = useState(stay);
  const initialTypeOption = findAccommodationTypeOption(stay.type);
  const [customType, setCustomType] = useState(initialTypeOption ? '' : stay.type || '');
  const selectedType = findAccommodationTypeOption(draft.type)?.value || 'Other';

  function changeStayType(value) {
    if (value === 'Other') {
      setDraft((current) => ({ ...current, type: customType.trim() || 'Other' }));
      return;
    }
    setDraft((current) => ({ ...current, type: value }));
  }

  function changeCustomType(value) {
    setCustomType(value);
    setDraft((current) => ({ ...current, type: value.trim() || 'Other' }));
  }

  return (
    <ModalShell
      title={stay.id ? 'Accommodation details' : 'Add accommodation'}
      onClose={onClose}
      footer={(
        <>
          <button className="overview-modal-secondary" onClick={onClose} type="button">Cancel</button>
          <button className="overview-modal-primary" onClick={() => onSave(draft)} type="button">Save stay</button>
        </>
      )}
    >
      <div className="overview-modal-grid">
        <label className="overview-modal-field overview-modal-field--full">
          <span>Name</span>
          <input className="trips-modal-input" value={draft.name} onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))} />
        </label>
        <label className="overview-modal-field">
          <span>Type</span>
          <select className="trips-modal-input" value={selectedType} onChange={(e) => changeStayType(e.target.value)}>
            {ACCOMMODATION_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.value}</option>
            ))}
          </select>
        </label>
        {selectedType === 'Other' && (
          <label className="overview-modal-field">
            <span>Custom type</span>
            <input className="trips-modal-input" value={customType} placeholder="Enter accommodation type" onChange={(e) => changeCustomType(e.target.value)} />
          </label>
        )}
        <label className="overview-modal-field">
          <span>Check-in</span>
          <input className="trips-modal-input" type="date" value={draft.checkIn} onChange={(e) => setDraft((current) => ({ ...current, checkIn: e.target.value }))} />
        </label>
        <label className="overview-modal-field">
          <span>Check-out</span>
          <input className="trips-modal-input" type="date" value={draft.checkOut} onChange={(e) => setDraft((current) => ({ ...current, checkOut: e.target.value }))} />
        </label>
        <label className="overview-modal-field overview-modal-field--full">
          <span>Address</span>
          <input className="trips-modal-input" value={draft.address} onChange={(e) => setDraft((current) => ({ ...current, address: e.target.value }))} />
        </label>
        <label className="overview-modal-field overview-modal-field--full">
          <span>Notes</span>
          <textarea className="trips-modal-input" rows={3} value={draft.notes} onChange={(e) => setDraft((current) => ({ ...current, notes: e.target.value }))} />
        </label>
        <div className="overview-modal-field--full">
          <AttachmentManager
            title="Accommodation documents"
            canUpload={canUpload}
            attachments={attachments}
            dashboard={dashboard}
            attachmentStatus={attachmentStatus}
            statusKey={`accommodation:${stay.id}:upload`}
            onUpload={onUploadAttachment}
            onOpen={onOpenAttachment}
            onDelete={onDeleteAttachment}
            compact
          />
        </div>
      </div>
    </ModalShell>
  );
}

function RentalCarModal({ rentalCar, dashboard, canUpload, attachments, attachmentStatus, onUploadAttachment, onOpenAttachment, onDeleteAttachment, onClose, onSave }) {
  const [draft, setDraft] = useState(rentalCar);

  return (
    <ModalShell
      title={rentalCar.id ? 'Rental car details' : 'Add rental car'}
      subtitle="Keep pickup, return, and confirmation details in one place."
      onClose={onClose}
      footer={(
        <>
          <button className="overview-modal-secondary" onClick={onClose} type="button">Cancel</button>
          <button className="overview-modal-primary" onClick={() => onSave(draft)} type="button">Save rental car</button>
        </>
      )}
    >
      <div className="overview-modal-grid">
        <label className="overview-modal-field overview-modal-field--full">
          <span>Rental company</span>
          <input className="trips-modal-input" value={draft.company} onChange={(e) => setDraft((current) => ({ ...current, company: e.target.value }))} />
        </label>

        <label className="overview-modal-field overview-modal-field--full">
          <span>Pickup location</span>
          <input className="trips-modal-input" value={draft.pickupLocation} onChange={(e) => setDraft((current) => ({ ...current, pickupLocation: e.target.value }))} />
        </label>

        <label className="overview-modal-field">
          <span>Pickup date</span>
          <input className="trips-modal-input" type="date" value={draft.pickupDate} onChange={(e) => setDraft((current) => ({ ...current, pickupDate: e.target.value }))} />
        </label>
        <label className="overview-modal-field">
          <span>Pickup time</span>
          <input className="trips-modal-input" type="time" value={draft.pickupTime} onChange={(e) => setDraft((current) => ({ ...current, pickupTime: e.target.value }))} />
        </label>

        <label className="overview-modal-field overview-modal-field--full">
          <span>Return location</span>
          <input className="trips-modal-input" value={draft.returnLocation} onChange={(e) => setDraft((current) => ({ ...current, returnLocation: e.target.value }))} />
        </label>

        <label className="overview-modal-field">
          <span>Return date</span>
          <input className="trips-modal-input" type="date" value={draft.returnDate} onChange={(e) => setDraft((current) => ({ ...current, returnDate: e.target.value }))} />
        </label>
        <label className="overview-modal-field">
          <span>Return time</span>
          <input className="trips-modal-input" type="time" value={draft.returnTime} onChange={(e) => setDraft((current) => ({ ...current, returnTime: e.target.value }))} />
        </label>

        <label className="overview-modal-field">
          <span>Car type</span>
          <input className="trips-modal-input" value={draft.carType} onChange={(e) => setDraft((current) => ({ ...current, carType: e.target.value }))} />
        </label>

        <label className="overview-modal-field">
          <span>Confirmation number</span>
          <input className="trips-modal-input" value={draft.confirmationNumber} onChange={(e) => setDraft((current) => ({ ...current, confirmationNumber: e.target.value }))} />
        </label>

        <label className="overview-modal-field">
          <span>Price</span>
          <input className="trips-modal-input" value={draft.price} onChange={(e) => setDraft((current) => ({ ...current, price: e.target.value }))} />
        </label>

        <label className="overview-modal-field overview-modal-field--full">
          <span>Notes</span>
          <textarea className="trips-modal-input" rows={3} value={draft.notes} onChange={(e) => setDraft((current) => ({ ...current, notes: e.target.value }))} />
        </label>
        <div className="overview-modal-field--full">
          <AttachmentManager
            title="Rental car documents"
            canUpload={canUpload}
            attachments={attachments}
            dashboard={dashboard}
            attachmentStatus={attachmentStatus}
            statusKey={`rentalCar:${rentalCar.id}:upload`}
            onUpload={onUploadAttachment}
            onOpen={onOpenAttachment}
            onDelete={onDeleteAttachment}
            compact
          />
        </div>
      </div>
    </ModalShell>
  );
}

function ExportModal({ selection, format, onToggleSelection, onChangeFormat, onClose, onExport }) {
  return (
    <ModalShell
      title="Export options"
      onClose={onClose}
      footer={(
        <>
          <button className="overview-modal-secondary" onClick={onClose} type="button">Cancel</button>
          <button className="overview-modal-primary" onClick={onExport} type="button">Export now</button>
        </>
      )}
    >
      <div className="overview-export-form">
        <div className="overview-export-section">
          <div className="overview-export-label">Choose sections</div>
          {[
            ['overview', 'Trip overview'],
            ['flights', 'Flights'],
            ['accommodation', 'Accommodation'],
            ['rentalCars', 'Rental cars'],
            ['documents', 'Trip documents'],
            ['itinerary', 'Daily itinerary'],
            ['notes', 'Notes'],
            ['packing', 'Packing list'],
            ['alerts', 'Weather alerts'],
            ['fallbacks', 'Fallback suggestions'],
          ].map(([key, label]) => (
            <label key={key} className="overview-export-check">
              <input type="checkbox" checked={selection[key]} onChange={() => onToggleSelection(key)} />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="overview-export-section">
          <div className="overview-export-label">Format</div>
          <label className="overview-export-radio">
            <input type="radio" name="export-format" checked={format === 'pdf'} onChange={() => onChangeFormat('pdf')} />
            <span>PDF</span>
          </label>
          <label className="overview-export-radio">
            <input type="radio" name="export-format" checked={format === 'excel'} onChange={() => onChangeFormat('excel')} />
            <span>Excel</span>
          </label>
        </div>
      </div>
    </ModalShell>
  );
}
