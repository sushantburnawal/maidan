import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import {
  BrowserRouter,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate
} from 'react-router-dom';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';

import { apiClient, type ReadyResponse } from './lib/apiClient';
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
  const [selectedPillar, setSelectedPillar] = useState<'move' | 'learn' | 'feel'>('move');

  useEffect(() => {
    if (mapContainerRef.current === null || mapRef.current !== null) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: osmStyle,
      center: [77.5946, 12.9716],
      zoom: 11.4,
      attributionControl: false
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

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
        <p className="eyebrow">Realtime</p>
        <strong>{realtimeStatus}</strong>
        <span>
          Socket auth uses the same bearer token as REST. Sign-in lands in W1; stored tokens connect
          automatically.
        </span>
      </aside>
      <button className="create-fab" type="button" aria-label="Create a hangout">
        +
      </button>
    </section>
  );
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
