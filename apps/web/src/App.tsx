import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement
} from 'react';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams
} from 'react-router-dom';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import type { ActivityPillar, GeoPoint } from '@maidan/shared';

import { apiClient, type ReadyResponse } from './lib/apiClient';
import type { NearbyActivity } from './lib/apiTypes';
import {
  getAuthTokens,
  setAuthTokens,
  subscribeAuthTokens,
  type AuthTokens
} from './lib/authTokens';
import { realtimeClient, type RealtimeStatus } from './lib/realtime';

const osmStyle: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: 'OpenStreetMap contributors'
    }
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm'
    }
  ]
};

const navItems = [
  { to: '/map', label: 'Map' },
  { to: '/feed', label: 'Feed' },
  { to: '/sutradhar', label: '✦' },
  { to: '/activities', label: 'Activities' },
  { to: '/you', label: 'You' }
] as const;

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/onboarding" element={<OnboardingScreen />} />
        <Route path="/*" element={<ProtectedAppShell />} />
      </Routes>
    </BrowserRouter>
  );
}

function ProtectedAppShell(): ReactElement {
  const tokens = useAuthTokenState();

  if (tokens === null) {
    return <Navigate to="/onboarding" replace />;
  }

  return <AppShell hasTokens={tokens !== null} />;
}

function AppShell({ hasTokens }: { hasTokens: boolean }): ReactElement {
  const [ready, setReady] = useState<ReadyResponse | null>(null);
  const [readyError, setReadyError] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>(realtimeClient.getStatus());

  useEffect(() => {
    let cancelled = false;

    apiClient
      .getReady()
      .then((response) => {
        if (!cancelled) {
          setReady(response);
          setReadyError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReady(null);
          setReadyError(error instanceof Error ? error.message : 'Unable to reach API');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => realtimeClient.subscribeStatus(setRealtimeStatus), []);

  useEffect(() => {
    realtimeClient.connect();

    return () => {
      realtimeClient.disconnect();
    };
  }, [hasTokens]);

  const connectionLabel = useMemo(() => {
    if (ready?.status === 'ok') {
      return 'connected';
    }

    if (readyError !== null) {
      return 'offline';
    }

    return 'checking';
  }, [ready, readyError]);

  return (
    <div className="app-shell">
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Navigate to="/map" replace />} />
          <Route
            path="/map"
            element={<MapHome connectionLabel={connectionLabel} realtimeStatus={realtimeStatus} />}
          />
          <Route path="/feed" element={<Placeholder title="Feed" eyebrow="Following / Discover" />} />
          <Route
            path="/sutradhar"
            element={<Placeholder title="Sutradhar" eyebrow="Grounded suggestions" />}
          />
          <Route
            path="/activities"
            element={<Placeholder title="Activities" eyebrow="Hosting / Joined" />}
          />
          <Route path="/activities/:activityId" element={<ActivityDetailStub />} />
          <Route path="/you" element={<Placeholder title="You" eyebrow="Profile and host mode" />} />
          <Route path="*" element={<Navigate to="/map" replace />} />
        </Routes>
      </main>
      <BottomNav />
    </div>
  );
}

function MapHome({
  connectionLabel,
  realtimeStatus
}: {
  connectionLabel: string;
  realtimeStatus: RealtimeStatus;
}): ReactElement {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [selectedPillar, setSelectedPillar] = useState<ActivityPillar>('move');
  const [activities, setActivities] = useState<NearbyActivity[]>([]);
  const [isLoadingActivities, setIsLoadingActivities] = useState(false);
  const [activitiesError, setActivitiesError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<GeoPoint>({ lat: 13.3702, lng: 77.6835 });
  const navigate = useNavigate();

  useEffect(() => {
    if (mapContainerRef.current === null || mapRef.current !== null) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: osmStyle,
      center: [77.6835, 13.3702],
      zoom: 11.2,
      attributionControl: false
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.once('load', () => setIsMapReady(true));
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const loadNearbyActivities = useCallback(async () => {
    const map = mapRef.current;

    if (map === null) {
      return;
    }

    const bounds = map.getBounds();
    const center = map.getCenter();
    setIsLoadingActivities(true);
    setActivitiesError(null);

    try {
      const nearby = await apiClient.activities.nearby<NearbyActivity>({
        lat: center.lat,
        lng: center.lng,
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
        radiusKm: 25,
        pillar: selectedPillar
      });
      setActivities(nearby);
    } catch (error) {
      setActivities([]);
      setActivitiesError(error instanceof Error ? error.message : 'Unable to load nearby activities');
    } finally {
      setIsLoadingActivities(false);
    }
  }, [selectedPillar]);

  useEffect(() => {
    if (!isMapReady) {
      return undefined;
    }

    const map = mapRef.current;

    if (map === null) {
      return undefined;
    }

    const handleIdle = (): void => {
      void loadNearbyActivities();
    };

    void loadNearbyActivities();
    map.on('idle', handleIdle);

    return () => {
      map.off('idle', handleIdle);
    };
  }, [isMapReady, loadNearbyActivities]);

  useEffect(() => {
    if (!isMapReady) {
      return undefined;
    }

    const map = mapRef.current;

    if (map === null || !('geolocation' in navigator)) {
      return undefined;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        setUserLocation(location);
        map.flyTo({ center: [location.lng, location.lat], zoom: Math.max(map.getZoom(), 12) });
      },
      () => undefined,
      { maximumAge: 60_000, timeout: 2500 }
    );

    return undefined;
  }, [isMapReady]);

  useEffect(() => {
    if (!isMapReady) {
      return undefined;
    }

    const map = mapRef.current;

    if (map === null) {
      return undefined;
    }

    const element = document.createElement('div');
    element.className = 'user-location-marker';
    element.setAttribute('aria-label', 'Selected location');
    const marker = new maplibregl.Marker({ element })
      .setLngLat([userLocation.lng, userLocation.lat])
      .addTo(map);

    return () => {
      marker.remove();
    };
  }, [isMapReady, userLocation]);

  useEffect(() => {
    if (!isMapReady) {
      return undefined;
    }

    const map = mapRef.current;

    if (map === null) {
      return undefined;
    }

    const markers = activities.map((activity) => {
      const element = document.createElement('button');
      element.className = `activity-pin activity-pin-${activity.pillar}`;
      element.type = 'button';
      element.setAttribute('aria-label', activity.title);
      const label = document.createElement('span');
      label.textContent = pillarInitial(activity.pillar);
      element.append(label);
      element.addEventListener('click', () => {
        navigate(`/activities/${activity.id}`, { state: { activity } });
      });

      return new maplibregl.Marker({ element, anchor: 'bottom' })
        .setLngLat([activity.location.lng, activity.location.lat])
        .addTo(map);
    });

    return () => {
      markers.forEach((marker) => marker.remove());
    };
  }, [activities, isMapReady, navigate]);

  function useMapCenterAsLocation(): void {
    const center = mapRef.current?.getCenter();

    if (center === undefined) {
      return;
    }

    setUserLocation({ lat: center.lat, lng: center.lng });
    void loadNearbyActivities();
  }

  function locateMe(): void {
    if (!('geolocation' in navigator)) {
      setActivitiesError('Browser location is unavailable');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        setUserLocation(location);
        mapRef.current?.flyTo({ center: [location.lng, location.lat], zoom: 12 });
      },
      () => setActivitiesError('Could not read browser location'),
      { maximumAge: 30_000, timeout: 5000 }
    );
  }

  return (
    <section className="map-screen">
      <div ref={mapContainerRef} className="map-canvas" aria-label="Bengaluru activity map" />
      <header className="map-topbar">
        <div className="brand-row">
          <div>
            <p className="eyebrow">Maidan</p>
            <h1>Move nearby</h1>
          </div>
          <div className={`status-pill status-${connectionLabel}`}>{connectionLabel}</div>
        </div>
        <p className="caption">
          <span>mind</span>, <span>body</span> & <span>soul</span>
        </p>
        <div className="chip-row" aria-label="Activity filters">
          {(['move', 'learn', 'feel'] as const).map((pillar) => (
            <button
              className={pillar === selectedPillar ? 'chip chip-selected' : 'chip'}
              key={pillar}
              type="button"
              onClick={() => setSelectedPillar(pillar)}
            >
              {pillar}
            </button>
          ))}
        </div>
      </header>
      <aside className="map-card">
        <div className="location-actions">
          <button type="button" onClick={locateMe}>
            Locate me
          </button>
          <button type="button" onClick={useMapCenterAsLocation}>
            Use map center
          </button>
        </div>
        <p className="eyebrow">Nearby {selectedPillar}</p>
        <strong>{isLoadingActivities ? 'Loading...' : `${activities.length} hangouts`}</strong>
        <span className="realtime-line">Realtime: {realtimeStatus}</span>
        {activitiesError !== null ? <p className="inline-error">{activitiesError}</p> : null}
        <div className="nearby-list">
          {activities.slice(0, 4).map((activity) => (
            <button
              key={activity.id}
              onClick={() => navigate(`/activities/${activity.id}`, { state: { activity } })}
              type="button"
            >
              <b>{activity.title}</b>
              <span>
                {formatDistance(activity.distance_m)} · {formatSlot(activity)}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <button className="create-fab" type="button" aria-label="Create a hangout">
        +
      </button>
    </section>
  );
}

function ActivityDetailStub(): ReactElement {
  const navigate = useNavigate();
  const { activityId } = useParams();
  const location = useLocation();
  const activity = getActivityFromRouteState(location.state);

  return (
    <section className="detail-stub">
      <button className="text-button" onClick={() => navigate(-1)} type="button">
        Back to map
      </button>
      <p className="eyebrow">Activity detail</p>
      <h1>{activity?.title ?? 'Activity'}</h1>
      <p>{activity?.description ?? `Detail route ready for ${activityId ?? 'this activity'}.`}</p>
      {activity?.next_open_slot !== null && activity?.next_open_slot !== undefined ? (
        <div className="detail-stub-slot">
          Next slot: {new Date(activity.next_open_slot.starts_at).toLocaleString()}
        </div>
      ) : null}
    </section>
  );
}

function getActivityFromRouteState(state: unknown): NearbyActivity | undefined {
  if (typeof state !== 'object' || state === null || !('activity' in state)) {
    return undefined;
  }

  const candidate = (state as { activity?: unknown }).activity;

  if (typeof candidate !== 'object' || candidate === null || !('id' in candidate)) {
    return undefined;
  }

  return candidate as NearbyActivity;
}

function pillarInitial(pillar: ActivityPillar): string {
  return pillar.slice(0, 1).toUpperCase();
}

function formatDistance(distanceM: number | null): string {
  if (distanceM === null) {
    return 'nearby';
  }

  if (distanceM < 1000) {
    return `${distanceM} m`;
  }

  return `${(distanceM / 1000).toFixed(1)} km`;
}

function formatSlot(activity: NearbyActivity): string {
  if (activity.next_open_slot === null) {
    return 'slots opening soon';
  }

  return new Date(activity.next_open_slot.starts_at).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short'
  });
}

function OnboardingScreen(): ReactElement {
  const navigate = useNavigate();
  const tokens = useAuthTokenState();
  const [phone, setPhone] = useState('+919900000101');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (tokens !== null) {
      navigate('/map', { replace: true });
    }
  }, [navigate, tokens]);

  async function requestOtp(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await apiClient.auth.requestOtp(phone);
      setStep('otp');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to request OTP');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function verifyOtp(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const verifiedTokens = await apiClient.auth.verifyOtp(phone, code);
      setAuthTokens(verifiedTokens);
      navigate('/map', { replace: true });
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : 'Unable to verify OTP');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="onboarding-screen">
      <section className="onboarding-card">
        <p className="eyebrow">Maidan</p>
        <h1>Step into your local circle</h1>
        <p className="onboarding-copy">
          Sign in with phone OTP. Local seed explorer: +919900000101.
        </p>

        {step === 'phone' ? (
          <form className="auth-form" onSubmit={(event) => void requestOtp(event)}>
            <label htmlFor="phone">Phone</label>
            <input
              autoComplete="tel"
              id="phone"
              inputMode="tel"
              name="phone"
              onChange={(event) => setPhone(event.target.value)}
              required
              type="tel"
              value={phone}
            />
            <button className="primary-button" disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Sending...' : 'Send OTP'}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={(event) => void verifyOtp(event)}>
            <label htmlFor="otp">OTP</label>
            <input
              autoComplete="one-time-code"
              id="otp"
              inputMode="numeric"
              maxLength={6}
              name="otp"
              onChange={(event) => setCode(event.target.value)}
              pattern="[0-9]{6}"
              required
              type="text"
              value={code}
            />
            <button className="primary-button" disabled={isSubmitting} type="submit">
              {isSubmitting ? 'Verifying...' : 'Verify and enter'}
            </button>
            <button
              className="text-button"
              disabled={isSubmitting}
              onClick={() => {
                setCode('');
                setStep('phone');
                setError(null);
              }}
              type="button"
            >
              Change phone
            </button>
          </form>
        )}

        {error !== null ? <p className="form-error">{error}</p> : null}
      </section>
    </main>
  );
}

function useAuthTokenState(): AuthTokens | null {
  const [tokens, setTokens] = useState<AuthTokens | null>(() => getAuthTokens());

  useEffect(() => subscribeAuthTokens(setTokens), []);

  return tokens;
}

function Placeholder({ title, eyebrow }: { title: string; eyebrow: string }): ReactElement {
  return (
    <section className="placeholder-screen">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
    </section>
  );
}

function BottomNav(): ReactElement {
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      {navItems.map((item) => (
        <NavLink
          className={({ isActive }) => (isActive ? 'nav-item nav-item-active' : 'nav-item')}
          key={item.to}
          to={item.to}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
