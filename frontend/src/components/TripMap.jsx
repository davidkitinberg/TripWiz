import React, { useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

function BoundsUpdater({ allPoints }) {
  const map = useMap();
  const prevKeyRef = useRef('');
  useEffect(() => {
    if (allPoints.length === 0) return;
    const key = allPoints.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');
    if (key === prevKeyRef.current) return;
    prevKeyRef.current = key;
    const bounds = L.latLngBounds(allPoints.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
  }, [allPoints, map]);
  return null;
}

export default function TripMap({ dayGroups }) {
  const allPoints = dayGroups.flatMap((g) => g.points);
  const defaultCenter = allPoints.length > 0 ? [allPoints[0].lat, allPoints[0].lng] : [20, 0];
  const defaultZoom = allPoints.length > 0 ? 12 : 2;

  return (
    <MapContainer
      center={defaultCenter}
      zoom={defaultZoom}
      style={{ height: '100%', width: '100%', minHeight: '350px' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {dayGroups.map((group) => {
        const line = group.points.map((p) => [p.lat, p.lng]);
        return (
          <React.Fragment key={group.dayIndex}>
            {line.length > 1 && (
              <Polyline
                positions={line}
                color={group.color}
                weight={2.5}
                dashArray="6 4"
                opacity={0.85}
              />
            )}
            {group.points.map((point, idx) => {
              const icon = L.divIcon({
                className: '',
                html: `<div style="
                  background: ${group.color};
                  color: white;
                  border-radius: 50%;
                  width: 28px;
                  height: 28px;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  font-size: 12px;
                  font-weight: 700;
                  border: 2px solid white;
                  box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                ">${point.globalNum}</div>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14],
              });
              return (
                <Marker key={`${group.dayIndex}-${idx}`} position={[point.lat, point.lng]} icon={icon}>
                  <Popup>
                    <strong>{point.title}</strong>
                    {point.startTime && <><br />{point.startTime}</>}
                  </Popup>
                </Marker>
              );
            })}
          </React.Fragment>
        );
      })}

      {allPoints.length > 0 && <BoundsUpdater allPoints={allPoints} />}
    </MapContainer>
  );
}
