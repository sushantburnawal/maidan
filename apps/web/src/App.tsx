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
  useParams,
  useSearchParams,
  type NavigateFunction
} from 'react-router-dom';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import type { ActivityPillar, ActivitySlot, Booking, GeoPoint, GroupChat, Payment } from '@maidan/shared';

import { apiClient, type ReadyResponse } from './lib/apiClient';
import type {
  ApiActivity,
  ActivityDetail,
  ActivityVibe,
  ChatListItem,
  ChatMemberSummary,
  ChatMessage,
  CreateBookingResponse,
  FeedPost,
  FollowProfileSummary,
  HostedActivity,
  HostProfileRecord,
  InitPaymentResponse,
  JoinedChatState,
  NearbyActivity,
  PaginatedFeedResponse,
  PaginatedFollowsResponse,
  PaginatedMessagesResponse,
  PaymentWebhookResponse,
  PrivateProfile,
  PublicProfile,
  RemoveChatMemberResponse
} from './lib/apiTypes';
import {
  getAuthTokens,
  setAuthTokens,
  subscribeAuthTokens,
  type AuthTokens
} from './lib/authTokens';
import { realtimeClient, type CompactMessage, type RealtimeStatus } from './lib/realtime';

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

const joinedChatsStorageKey = 'maidan.joinedChats.v1';

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
          <Route path="/feed" element={<FeedScreen />} />
          <Route path="/sutradhar" element={<SutradharScreen />} />
          <Route path="/activities" element={<ActivitiesScreen />} />
          <Route path="/activities/new" element={<CreateActivityScreen />} />
          <Route path="/activities/:activityId" element={<ActivityDetailScreen />} />
          <Route path="/activities/:activityId/join" element={<JoinFlowScreen />} />
          <Route path="/activities/:activityId/manage" element={<ManageActivityScreen />} />
          <Route path="/chats/:chatId" element={<ChatRoomScreen />} />
          <Route path="/profiles/:profileId" element={<ProfileScreen />} />
          <Route path="/you" element={<YouScreen />} />
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
              data-testid="nearby-activity"
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
      <button
        className="create-fab"
        onClick={() => navigate('/activities/new')}
        type="button"
        aria-label="Create a hangout"
      >
        +
      </button>
    </section>
  );
}

type FeedScope = 'following' | 'global';

function FeedScreen(): ReactElement {
  const navigate = useNavigate();
  const [scope, setScope] = useState<FeedScope>('following');
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFeed = useCallback(
    async ({ cursor, reset }: { cursor?: string | null; reset: boolean }) => {
      if (reset) {
        setIsLoading(true);
        setPosts([]);
        setNextCursor(null);
      } else {
        setIsLoadingMore(true);
      }

      setError(null);

      try {
        const response = await apiClient.posts.feed<PaginatedFeedResponse>(
          scope,
          cursor ?? undefined
        );

        setPosts((currentPosts) =>
          reset ? response.items : appendUniqueFeedPosts(currentPosts, response.items)
        );
        setNextCursor(response.next_cursor);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load feed');
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [scope]
  );

  useEffect(() => {
    void loadFeed({ reset: true });
  }, [loadFeed]);

  useEffect(() => {
    return realtimeClient.on('feed:new', () => {
      void loadFeed({ reset: true });
    });
  }, [loadFeed]);

  return (
    <section className="feed-screen">
      <header className="feed-header">
        <div>
          <p className="eyebrow">Feed</p>
          <h1>{scope === 'following' ? 'Your circle' : 'Discover'}</h1>
        </div>
        <div className="feed-tabs" aria-label="Feed scope">
          <button
            className={scope === 'following' ? 'feed-tab feed-tab-active' : 'feed-tab'}
            onClick={() => setScope('following')}
            type="button"
          >
            Following
          </button>
          <button
            className={scope === 'global' ? 'feed-tab feed-tab-active' : 'feed-tab'}
            onClick={() => setScope('global')}
            type="button"
          >
            Discover
          </button>
        </div>
      </header>

      {error !== null ? <p className="inline-error">{error}</p> : null}
      {isLoading && posts.length === 0 ? <p className="feed-loading">Loading feed...</p> : null}
      {!isLoading && posts.length === 0 && error === null ? (
        <div className="feed-empty">
          <p className="eyebrow">{scope === 'following' ? 'Following' : 'Discover'}</p>
          <h2>No posts yet</h2>
          <p className="muted-copy">
            {scope === 'following'
              ? 'Follow a host to see their activity updates here.'
              : 'Fresh activity updates will appear here.'}
          </p>
        </div>
      ) : null}

      <div className="feed-list">
        {posts.map((post) => (
          <FeedPostCard
            key={post.id}
            post={post}
            onOpenActivity={(activityId) => navigate(`/activities/${activityId}`)}
          />
        ))}
      </div>

      {nextCursor !== null ? (
        <button
          className="load-more-button"
          disabled={isLoadingMore}
          onClick={() => void loadFeed({ cursor: nextCursor, reset: false })}
          type="button"
        >
          {isLoadingMore ? 'Loading...' : 'Load more'}
        </button>
      ) : null}
    </section>
  );
}

function FeedPostCard({
  onOpenActivity,
  post
}: {
  onOpenActivity: (activityId: string) => void;
  post: FeedPost;
}): ReactElement {
  const linkedActivity = post.linked_activity;

  return (
    <article className="feed-post">
      <div className="feed-post-meta">
        <span>Host {shortId(post.author_id)}</span>
        <time dateTime={post.created_at}>{formatFeedDate(post.created_at)}</time>
      </div>
      <p>{post.body}</p>
      {linkedActivity !== null ? (
        <button
          className={`feed-activity-card feed-activity-${linkedActivity.pillar}`}
          data-testid="feed-linked-activity"
          onClick={() => onOpenActivity(linkedActivity.id)}
          type="button"
        >
          <span>{formatPillarLabel(linkedActivity.pillar)}</span>
          <strong>{linkedActivity.title}</strong>
          <small>
            {formatFeedActivitySlot(linkedActivity.next_slot)} ·{' '}
            {formatInr(linkedActivity.price.amount_inr)}
          </small>
          <small>Fairness {Math.round(linkedActivity.fairness_score)}/100</small>
        </button>
      ) : null}
    </article>
  );
}

interface SutradharMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  options: ActivityDetail[];
}

interface SutradharFinalEvent {
  activity_ids?: string[];
  demand_signal_id?: string | null;
  error?: 'rate_limited';
  type: 'final';
}

interface SutradharDeltaEvent {
  text?: string;
  type: 'delta';
}

type SutradharStreamEvent = SutradharDeltaEvent | SutradharFinalEvent;

function SutradharScreen(): ReactElement {
  const navigate = useNavigate();
  const [sessionId] = useState(() => `web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [messages, setMessages] = useState<SutradharMessage[]>([
    {
      id: 'intro',
      role: 'assistant',
      text: 'Ask for a grounded Maidan option. I will only point to activities the backend returns.',
      options: []
    }
  ]);
  const [draft, setDraft] = useState('Find me the Nandi ride');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    const message = draft.trim();

    if (message.length === 0 || isSending) {
      return;
    }

    const userMessage: SutradharMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: message,
      options: []
    };
    const assistantMessageId = `assistant-${Date.now()}`;
    const assistantMessage: SutradharMessage = {
      id: assistantMessageId,
      role: 'assistant',
      text: '',
      options: []
    };

    setMessages((currentMessages) => [...currentMessages, userMessage, assistantMessage]);
    setDraft('');
    setIsSending(true);
    setError(null);

    try {
      const finalEvent = await streamSutradharReply(
        message,
        sessionId,
        (text) => {
          setMessages((currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === assistantMessageId
                ? { ...currentMessage, text: currentMessage.text + text }
                : currentMessage
            )
          );
        }
      );
      const optionIds = finalEvent.activity_ids ?? [];
      const options = await loadSutradharOptions(optionIds);

      setMessages((currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === assistantMessageId
            ? {
                ...currentMessage,
                options
              }
            : currentMessage
        )
      );
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Sutradhar could not reply');
      setMessages((currentMessages) =>
        currentMessages.map((currentMessage) =>
          currentMessage.id === assistantMessageId && currentMessage.text.length === 0
            ? {
                ...currentMessage,
                text: 'Sutradhar is unavailable right now.'
              }
            : currentMessage
        )
      );
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className="sutradhar-screen">
      <header className="sutradhar-header">
        <div>
          <p className="eyebrow">Sutradhar</p>
          <h1>✦</h1>
        </div>
        <p className="muted-copy">Grounded suggestions only. Bookings stay in your hands.</p>
      </header>

      {error !== null ? <p className="inline-error">{error}</p> : null}

      <div className="sutradhar-thread" aria-live="polite">
        {messages.map((message) => (
          <article
            className={
              message.role === 'user'
                ? 'sutradhar-message sutradhar-message-user'
                : 'sutradhar-message'
            }
            key={message.id}
          >
            <p className="eyebrow">{message.role === 'user' ? 'You' : 'Sutradhar'}</p>
            <p>{message.text.length === 0 ? 'Thinking...' : message.text}</p>
            {message.options.length > 0 ? (
              <div className="sutradhar-options">
                {message.options.map((activity) => (
                  <button
                    className={`sutradhar-option sutradhar-option-${activity.pillar}`}
                    key={activity.id}
                    onClick={() => navigate(`/activities/${activity.id}`)}
                    type="button"
                  >
                    <span>{formatPillarLabel(activity.pillar)}</span>
                    <strong>{activity.title}</strong>
                    <small>
                      {activity.upcoming_open_slots[0] === undefined
                        ? 'Slots opening soon'
                        : formatSlotDateRange(
                            activity.upcoming_open_slots[0].starts_at,
                            activity.upcoming_open_slots[0].ends_at
                          )}
                    </small>
                  </button>
                ))}
              </div>
            ) : null}
          </article>
        ))}
      </div>

      <form className="sutradhar-compose" onSubmit={(event) => void sendMessage(event)}>
        <label htmlFor="sutradhar-message">Ask Sutradhar</label>
        <input
          id="sutradhar-message"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button className="primary-button" disabled={isSending || draft.trim().length === 0} type="submit">
          {isSending ? 'Asking...' : 'Ask'}
        </button>
      </form>
    </section>
  );
}

type ActivitiesTab = 'hosting' | 'joined';

interface ActivityComposerState {
  title: string;
  description: string;
  pillar: ActivityPillar;
  category: string;
  meetingPoint: string;
  lat: string;
  lng: string;
  basePriceInr: string;
  capacity: string;
  startsAt: string;
  endsAt: string;
}

function ActivitiesScreen(): ReactElement {
  const navigate = useNavigate();
  const [tab, setTab] = useState<ActivitiesTab>('hosting');
  const [hostedActivities, setHostedActivities] = useState<HostedActivity[]>([]);
  const [joinedBookings, setJoinedBookings] = useState<Booking[]>([]);
  const [groupChats, setGroupChats] = useState<ChatListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadActivities = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [hosting, joined, chats] = await Promise.all([
        apiClient.activities.mine<HostedActivity>(),
        apiClient.bookings.mine<Booking>(),
        apiClient.chats.mine<ChatListItem>()
      ]);

      setHostedActivities(hosting);
      setJoinedBookings(joined);
      setGroupChats(chats);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load activities');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadActivities();
  }, [loadActivities]);

  const hostedChatByActivityId = useMemo(() => {
    const chatsByActivityId = new Map<string, ChatListItem>();

    for (const chatItem of groupChats) {
      if (chatItem.role === 'host') {
        chatsByActivityId.set(chatItem.activity.id, chatItem);
      }
    }

    return chatsByActivityId;
  }, [groupChats]);

  const joinedGroupChats = useMemo(
    () => groupChats.filter((chatItem) => chatItem.role === 'member'),
    [groupChats]
  );

  return (
    <section className="activities-screen">
      <header className="activities-header">
        <div>
          <p className="eyebrow">Activities</p>
          <h1>{tab === 'hosting' ? 'Hosting' : 'Joined'}</h1>
        </div>
        <button className="primary-button" onClick={() => navigate('/activities/new')} type="button">
          Create
        </button>
      </header>

      <div className="feed-tabs activities-tabs" aria-label="Activities view">
        <button
          className={tab === 'hosting' ? 'feed-tab feed-tab-active' : 'feed-tab'}
          onClick={() => setTab('hosting')}
          type="button"
        >
          Hosting
        </button>
        <button
          className={tab === 'joined' ? 'feed-tab feed-tab-active' : 'feed-tab'}
          onClick={() => setTab('joined')}
          type="button"
        >
          Joined
        </button>
      </div>

      {error !== null ? <p className="inline-error">{error}</p> : null}
      {isLoading ? <p className="feed-loading">Loading activities...</p> : null}

      {tab === 'hosting' ? (
        <div className="activity-list">
          {!isLoading && hostedActivities.length === 0 ? (
            <div className="feed-empty">
              <p className="eyebrow">Hosting</p>
              <h2>No hosted hangouts yet</h2>
              <p className="muted-copy">Create a hangout when you have a clear plan and capacity.</p>
            </div>
          ) : null}
          {hostedActivities.map((activity) => {
            const activityChat = hostedChatByActivityId.get(activity.id);

            return (
              <article className="activity-list-card" key={activity.id}>
                <div>
                  <p className="eyebrow">{activity.pillar} · {activity.status}</p>
                  <h2>{activity.title}</h2>
                  <p className="muted-copy">
                    {activity.next_open_slot === null
                      ? 'No open slots'
                      : formatSlotDateRange(
                          activity.next_open_slot.starts_at,
                          activity.next_open_slot.ends_at
                        )}
                  </p>
                </div>
                <div className="activity-list-actions">
                  <strong>{formatInr(activity.base_price_inr)}</strong>
                  {activityChat !== undefined ? (
                    <button
                      className="secondary-button"
                      data-testid="hosted-activity-chat-button"
                      onClick={() => openChatFromSummary(navigate, activityChat)}
                      type="button"
                    >
                      Open chat
                    </button>
                  ) : null}
                  <button
                    className="secondary-button"
                    onClick={() => navigate(`/activities/${activity.id}/manage`)}
                    type="button"
                  >
                    Manage
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="activity-list">
          {!isLoading && joinedBookings.length === 0 && joinedGroupChats.length === 0 ? (
            <div className="feed-empty">
              <p className="eyebrow">Joined</p>
              <h2>No bookings yet</h2>
              <p className="muted-copy">Your confirmed and pending activity bookings appear here.</p>
            </div>
          ) : null}
          {joinedGroupChats.length > 0 ? (
            <section className="activity-chat-section">
              <div className="section-heading">
                <p className="eyebrow">Group chats</p>
                <h2>Activity groups</h2>
              </div>
              {joinedGroupChats.map((chatItem) => (
                <article className="activity-list-card" key={chatItem.chat.id}>
                  <div>
                    <p className="eyebrow">
                      {chatItem.activity.pillar} · {chatItem.activity.status}
                    </p>
                    <h2>{chatItem.activity.title}</h2>
                    <p className="muted-copy">{chatItem.chat.title}</p>
                  </div>
                  <button
                    className="secondary-button"
                    data-testid="joined-activity-chat-button"
                    onClick={() => openChatFromSummary(navigate, chatItem)}
                    type="button"
                  >
                    Open chat
                  </button>
                </article>
              ))}
            </section>
          ) : null}
          {joinedBookings.map((booking) => (
            <article className="activity-list-card" key={booking.id}>
              <div>
                <p className="eyebrow">Booking · {booking.status}</p>
                <h2>{formatInr(booking.amount_inr)}</h2>
                <p className="muted-copy">Slot {shortId(booking.slot_id)}</p>
              </div>
              <span className="member-pill">{booking.headcount} spot</span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function CreateActivityScreen(): ReactElement {
  const navigate = useNavigate();
  const [form, setForm] = useState(() => defaultActivityComposerState());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateForm(field: keyof ActivityComposerState, value: string): void {
    setForm((currentForm) => ({
      ...currentForm,
      [field]: field === 'pillar' ? toActivityPillar(value) : value
    }));
  }

  const updateLocation = useCallback((location: GeoPoint): void => {
    setForm((currentForm) => ({
      ...currentForm,
      lat: formatCoordinate(location.lat),
      lng: formatCoordinate(location.lng)
    }));
  }, []);

  async function createActivity(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await apiClient.profiles.becomeHost<HostProfileRecord>();
      const createdActivity = await apiClient.activities.create<ApiActivity>({
        title: form.title.trim(),
        description: form.description.trim(),
        pillar: form.pillar,
        category: form.category.trim(),
        meetingPoint: form.meetingPoint.trim(),
        location: {
          lat: Number(form.lat),
          lng: Number(form.lng)
        },
        basePriceInr: Number(form.basePriceInr),
        capacity: Number(form.capacity),
        media: []
      });

      await apiClient.activities.createSlot<ActivitySlot>(createdActivity.id, {
        startsAt: datetimeLocalToIso(form.startsAt),
        endsAt: datetimeLocalToIso(form.endsAt),
        capacity: Number(form.capacity)
      });
      await apiClient.activities.publish<ApiActivity>(createdActivity.id);
      navigate(`/activities/${createdActivity.id}/manage`, { replace: true });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create activity');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="composer-screen">
      <button className="text-button" onClick={() => navigate('/activities')} type="button">
        Back
      </button>
      <form className="activity-composer" onSubmit={(event) => void createActivity(event)}>
        <p className="eyebrow">Create a hangout</p>
        <h1>Post the plan</h1>
        <div className="maidan-way">
          <p className="eyebrow">The Maidan way</p>
          <p>Set a clear meeting point, hold only real capacity, and make the first message useful.</p>
        </div>

        <label>
          Title
          <input
            required
            value={form.title}
            onChange={(event) => updateForm('title', event.currentTarget.value)}
          />
        </label>
        <label>
          Description
          <textarea
            required
            rows={4}
            value={form.description}
            onChange={(event) => updateForm('description', event.currentTarget.value)}
          />
        </label>
        <div className="composer-grid">
          <label>
            Pillar
            <select
              value={form.pillar}
              onChange={(event) => updateForm('pillar', event.currentTarget.value)}
            >
              <option value="move">Move</option>
              <option value="learn">Learn</option>
              <option value="feel">Feel</option>
            </select>
          </label>
          <label>
            Category
            <input
              required
              value={form.category}
              onChange={(event) => updateForm('category', event.currentTarget.value)}
            />
          </label>
        </div>
        <label>
          Meeting point
          <input
            required
            value={form.meetingPoint}
            onChange={(event) => updateForm('meetingPoint', event.currentTarget.value)}
          />
        </label>
        <ActivityLocationPicker lat={form.lat} lng={form.lng} onChange={updateLocation} />
        <details className="coordinate-details">
          <summary>Advanced coordinates</summary>
          <div className="composer-grid">
            <label>
              Latitude
              <input
                required
                step="0.000001"
                type="number"
                value={form.lat}
                onChange={(event) => updateForm('lat', event.currentTarget.value)}
              />
            </label>
            <label>
              Longitude
              <input
                required
                step="0.000001"
                type="number"
                value={form.lng}
                onChange={(event) => updateForm('lng', event.currentTarget.value)}
              />
            </label>
          </div>
        </details>
        <div className="composer-grid">
          <label>
            Price
            <input
              min="0"
              required
              type="number"
              value={form.basePriceInr}
              onChange={(event) => updateForm('basePriceInr', event.currentTarget.value)}
            />
          </label>
          <label>
            Capacity
            <input
              min="1"
              required
              type="number"
              value={form.capacity}
              onChange={(event) => updateForm('capacity', event.currentTarget.value)}
            />
          </label>
        </div>
        <div className="composer-grid">
          <label>
            Starts
            <input
              required
              type="datetime-local"
              value={form.startsAt}
              onChange={(event) => updateForm('startsAt', event.currentTarget.value)}
            />
          </label>
          <label>
            Ends
            <input
              required
              type="datetime-local"
              value={form.endsAt}
              onChange={(event) => updateForm('endsAt', event.currentTarget.value)}
            />
          </label>
        </div>
        {error !== null ? <p className="form-error">{error}</p> : null}
        <button className="primary-button" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Publishing...' : 'Create and publish'}
        </button>
      </form>
    </section>
  );
}

interface ActivityLocationPickerProps {
  lat: string;
  lng: string;
  onChange: (location: GeoPoint) => void;
}

function ActivityLocationPicker({
  lat,
  lng,
  onChange
}: ActivityLocationPickerProps): ReactElement {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const [locationError, setLocationError] = useState<string | null>(null);
  const selectedLocation = parseComposerLocation(lat, lng) ?? defaultActivityLocation;
  const initialLocationRef = useRef(selectedLocation);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (mapContainerRef.current === null || mapRef.current !== null) {
      return undefined;
    }

    const initialLocation = initialLocationRef.current;
    const map = new maplibregl.Map({
      attributionControl: false,
      center: [initialLocation.lng, initialLocation.lat],
      container: mapContainerRef.current,
      style: osmStyle,
      zoom: 12.2
    });
    const markerElement = document.createElement('div');
    markerElement.className = 'composer-location-marker';
    markerElement.setAttribute('aria-label', 'Selected activity location');
    const marker = new maplibregl.Marker({
      anchor: 'bottom',
      draggable: true,
      element: markerElement
    })
      .setLngLat([initialLocation.lng, initialLocation.lat])
      .addTo(map);

    const updateSelectedLocation = (location: GeoPoint): void => {
      marker.setLngLat([location.lng, location.lat]);
      onChangeRef.current(location);
    };
    const handleMapClick = (event: maplibregl.MapMouseEvent): void => {
      updateSelectedLocation({ lat: event.lngLat.lat, lng: event.lngLat.lng });
    };
    const handleMarkerDragEnd = (): void => {
      const location = marker.getLngLat();
      onChangeRef.current({ lat: location.lat, lng: location.lng });
    };
    const resizeFrame = window.requestAnimationFrame(() => map.resize());

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('click', handleMapClick);
    marker.on('dragend', handleMarkerDragEnd);
    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      window.cancelAnimationFrame(resizeFrame);
      marker.off('dragend', handleMarkerDragEnd);
      marker.remove();
      map.off('click', handleMapClick);
      map.remove();
      markerRef.current = null;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const nextLocation = parseComposerLocation(lat, lng);
    const map = mapRef.current;
    const marker = markerRef.current;

    if (nextLocation === null || map === null || marker === null) {
      return;
    }

    const currentLocation = marker.getLngLat();

    if (
      Math.abs(currentLocation.lat - nextLocation.lat) > 0.000001 ||
      Math.abs(currentLocation.lng - nextLocation.lng) > 0.000001
    ) {
      marker.setLngLat([nextLocation.lng, nextLocation.lat]);
      map.setCenter([nextLocation.lng, nextLocation.lat]);
    }
  }, [lat, lng]);

  function useCurrentLocation(): void {
    if (!('geolocation' in navigator)) {
      setLocationError('Browser location is unavailable');
      return;
    }

    setLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = {
          lat: position.coords.latitude,
          lng: position.coords.longitude
        };

        markerRef.current?.setLngLat([location.lng, location.lat]);
        mapRef.current?.flyTo({ center: [location.lng, location.lat], zoom: 13 });
        onChange(location);
      },
      () => setLocationError('Could not read browser location'),
      { maximumAge: 30_000, timeout: 5000 }
    );
  }

  return (
    <section className="location-picker" aria-label="Activity location picker">
      <div className="location-picker-header">
        <div>
          <p className="eyebrow">Location</p>
          <strong>Selected point</strong>
        </div>
        <button type="button" onClick={useCurrentLocation}>
          Use my location
        </button>
      </div>
      <div
        ref={mapContainerRef}
        className="location-picker-map"
        data-testid="activity-location-map"
      />
      <div className="location-picker-readout">
        <span>Coordinates</span>
        <code data-testid="activity-location-coordinates">
          {formatCoordinate(selectedLocation.lat)}, {formatCoordinate(selectedLocation.lng)}
        </code>
      </div>
      {locationError !== null ? <p className="inline-error">{locationError}</p> : null}
    </section>
  );
}

function ManageActivityScreen(): ReactElement {
  const navigate = useNavigate();
  const { activityId } = useParams();
  const [activity, setActivity] = useState<ActivityDetail | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [activityChat, setActivityChat] = useState<ChatListItem | null>(null);
  const [chatMembers, setChatMembers] = useState<ChatMemberSummary[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [kickingProfileId, setKickingProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const loadManageContext = useCallback(async () => {
    if (activityId === undefined) {
      setError('Missing activity id');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const [detail, roster, chatItem] = await Promise.all([
        apiClient.activities.detail<ActivityDetail>(activityId),
        apiClient.activities.bookings<Booking>(activityId).catch((): Booking[] => []),
        apiClient.activities.chat<ChatListItem>(activityId).catch((): ChatListItem | null => null)
      ]);
      const members =
        chatItem === null
          ? []
          : await apiClient.chats
              .members<ChatMemberSummary>(chatItem.chat.id)
              .catch((): ChatMemberSummary[] => []);

      setActivity(detail);
      setBookings(roster);
      setActivityChat(chatItem);
      setChatMembers(members);
      setTitle(detail.title);
      setDescription(detail.description);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load host controls');
    } finally {
      setIsLoading(false);
    }
  }, [activityId]);

  useEffect(() => {
    void loadManageContext();
  }, [loadManageContext]);

  async function saveBasics(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (activity === null) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setSaveMessage(null);

    try {
      const updated = await apiClient.activities.update<ApiActivity>(activity.id, {
        title: title.trim(),
        description: description.trim()
      });

      setActivity({ ...activity, ...updated });
      setSaveMessage('Changes saved');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save activity');
    } finally {
      setIsSaving(false);
    }
  }

  async function kickChatMember(profileId: string): Promise<void> {
    if (activityChat === null || kickingProfileId !== null) {
      return;
    }

    setKickingProfileId(profileId);
    setError(null);
    setSaveMessage(null);

    try {
      await apiClient.chats.kickMember<RemoveChatMemberResponse>(activityChat.chat.id, profileId);
      setChatMembers((currentMembers) =>
        currentMembers.filter((member) => member.profile_id !== profileId)
      );
      setSaveMessage('Member removed from chat');
    } catch (kickError) {
      setError(kickError instanceof Error ? kickError.message : 'Unable to remove member');
    } finally {
      setKickingProfileId(null);
    }
  }

  async function applyStatus(action: 'publish' | 'pause' | 'archive'): Promise<void> {
    if (activity === null || isSaving) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setSaveMessage(null);

    try {
      const updated =
        action === 'publish'
          ? await apiClient.activities.publish<ApiActivity>(activity.id)
          : action === 'pause'
            ? await apiClient.activities.pause<ApiActivity>(activity.id)
            : await apiClient.activities.archive<ApiActivity>(activity.id);

      setActivity({ ...activity, ...updated });
      setSaveMessage('Status updated');
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : 'Unable to update status');
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <section className="manage-screen manage-state">
        <p className="eyebrow">Host controls</p>
        <h1>Loading activity...</h1>
      </section>
    );
  }

  if (activity === null) {
    return (
      <section className="manage-screen manage-state">
        <button className="text-button" onClick={() => navigate('/activities')} type="button">
          Back
        </button>
        <p className="eyebrow">Host controls</p>
        <h1>Could not load this activity</h1>
        <p className="muted-copy">{error ?? 'The activity was not found.'}</p>
      </section>
    );
  }

  return (
    <section className="manage-screen">
      <header className="activities-header">
        <div>
          <p className="eyebrow">Host controls · {activity.status}</p>
          <h1>{activity.title}</h1>
        </div>
        <div className="header-action-row">
          {activityChat !== null ? (
            <button
              className="secondary-button"
              onClick={() => openChatFromSummary(navigate, activityChat)}
              type="button"
            >
              Open chat
            </button>
          ) : null}
          <button className="secondary-button" onClick={() => navigate(`/activities/${activity.id}`)} type="button">
            View
          </button>
        </div>
      </header>

      {error !== null ? <p className="inline-error">{error}</p> : null}
      {saveMessage !== null ? <p className="inline-success">{saveMessage}</p> : null}

      <div className="manage-grid">
        <form className="manage-panel" onSubmit={(event) => void saveBasics(event)}>
          <p className="eyebrow">Basics</p>
          <label>
            Title
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.currentTarget.value);
                setSaveMessage(null);
              }}
            />
          </label>
          <label>
            Description
            <textarea
              rows={5}
              value={description}
              onChange={(event) => {
                setDescription(event.currentTarget.value);
                setSaveMessage(null);
              }}
            />
          </label>
          <button className="primary-button" disabled={isSaving} type="submit">
            {isSaving ? 'Saving...' : 'Save changes'}
          </button>
        </form>

        <section className="manage-panel">
          <p className="eyebrow">Status</p>
          <div className="status-action-row">
            <button
              className="secondary-button"
              disabled={isSaving}
              onClick={() => void applyStatus('publish')}
              type="button"
            >
              Publish
            </button>
            <button
              className="secondary-button"
              disabled={isSaving}
              onClick={() => void applyStatus('pause')}
              type="button"
            >
              Pause
            </button>
            <button
              className="secondary-button"
              disabled={isSaving}
              onClick={() => void applyStatus('archive')}
              type="button"
            >
              Archive
            </button>
          </div>
          <div className="slot-list">
            {activity.upcoming_open_slots.length === 0 ? (
              <p className="muted-copy">No open slots.</p>
            ) : (
              activity.upcoming_open_slots.map((slot) => (
                <article className="slot-card" key={slot.id}>
                  <div>
                    <strong>{formatSlotDateRange(slot.starts_at, slot.ends_at)}</strong>
                    <span>
                      {slot.booked_count}/{slot.capacity} booked · {slot.status}
                    </span>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>

        <section className="manage-panel roster-panel">
          <p className="eyebrow">Roster</p>
          {bookings.length === 0 ? (
            <p className="muted-copy">No bookings yet.</p>
          ) : (
            bookings.map((booking) => (
              <article className="roster-row" key={booking.id}>
                <div>
                  <strong>{shortId(booking.explorer_id)}</strong>
                  <span>{booking.status}</span>
                </div>
                <b>{booking.headcount}</b>
              </article>
            ))
          )}
          {activityChat !== null ? (
            <div className="chat-member-admin">
              <div>
                <p className="eyebrow">Group chat</p>
                <h2>{activityChat.chat.title}</h2>
              </div>
              {chatMembers.length === 0 ? (
                <p className="muted-copy">No chat members yet.</p>
              ) : (
                chatMembers.map((member) => (
                  <article className="roster-row" key={member.profile_id}>
                    <div>
                      <strong>{member.display_name}</strong>
                      <span>
                        {member.role} · joined {formatFeedDate(member.joined_at)}
                      </span>
                    </div>
                    {member.role === 'member' ? (
                      <button
                        className="secondary-button"
                        disabled={kickingProfileId !== null}
                        onClick={() => void kickChatMember(member.profile_id)}
                        type="button"
                      >
                        {kickingProfileId === member.profile_id ? 'Removing...' : 'Kick'}
                      </button>
                    ) : (
                      <span className="member-pill">Admin</span>
                    )}
                  </article>
                ))
              )}
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}

type FollowListKind = 'followers' | 'following';

function ProfileScreen(): ReactElement {
  const navigate = useNavigate();
  const { profileId } = useParams();
  const currentProfileId = getCurrentProfileId();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [postsCursor, setPostsCursor] = useState<string | null>(null);
  const [followListKind, setFollowListKind] = useState<FollowListKind>('followers');
  const [followRows, setFollowRows] = useState<FollowProfileSummary[]>([]);
  const [followCursor, setFollowCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdatingFollow, setIsUpdatingFollow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    if (profileId === undefined) {
      setError('Missing profile id');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const [publicProfile, profilePosts] = await Promise.all([
        apiClient.profiles.public<PublicProfile>(profileId),
        apiClient.profiles.posts<PaginatedFeedResponse>(profileId)
      ]);

      setProfile(publicProfile);
      setPosts(profilePosts.items);
      setPostsCursor(profilePosts.next_cursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load profile');
    } finally {
      setIsLoading(false);
    }
  }, [profileId]);

  const loadFollowRows = useCallback(
    async ({ cursor, reset }: { cursor?: string | null; reset: boolean }) => {
      if (profileId === undefined) {
        return;
      }

      const response =
        followListKind === 'followers'
          ? await apiClient.profiles.followers<PaginatedFollowsResponse>(
              profileId,
              cursor ?? undefined
            )
          : await apiClient.profiles.following<PaginatedFollowsResponse>(
              profileId,
              cursor ?? undefined
            );

      setFollowRows((currentRows) =>
        reset ? response.items : appendUniqueFollowRows(currentRows, response.items)
      );
      setFollowCursor(response.next_cursor);
    },
    [followListKind, profileId]
  );

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    setFollowRows([]);
    setFollowCursor(null);
    void loadFollowRows({ reset: true });
  }, [loadFollowRows]);

  async function toggleProfileFollow(): Promise<void> {
    if (profile === null || profile.id === currentProfileId || isUpdatingFollow) {
      return;
    }

    const wasFollowing = profile.is_following === true;
    setProfile({
      ...profile,
      is_following: !wasFollowing,
      follower_count: Math.max(0, profile.follower_count + (wasFollowing ? -1 : 1))
    });
    setIsUpdatingFollow(true);
    setError(null);

    try {
      if (wasFollowing) {
        await apiClient.profiles.unfollow<void>(profile.id);
      } else {
        await apiClient.profiles.follow<void>(profile.id);
      }
    } catch (followError) {
      setProfile(profile);
      setError(followError instanceof Error ? followError.message : 'Unable to update follow');
    } finally {
      setIsUpdatingFollow(false);
    }
  }

  async function toggleRowFollow(row: FollowProfileSummary): Promise<void> {
    if (row.id === currentProfileId) {
      return;
    }

    const wasFollowing = row.is_following === true;
    setFollowRows((currentRows) =>
      currentRows.map((currentRow) =>
        currentRow.id === row.id ? { ...currentRow, is_following: !wasFollowing } : currentRow
      )
    );

    try {
      if (wasFollowing) {
        await apiClient.profiles.unfollow<void>(row.id);
      } else {
        await apiClient.profiles.follow<void>(row.id);
      }
    } catch {
      setFollowRows((currentRows) =>
        currentRows.map((currentRow) =>
          currentRow.id === row.id ? { ...currentRow, is_following: wasFollowing } : currentRow
        )
      );
    }
  }

  async function loadMorePosts(): Promise<void> {
    if (profileId === undefined || postsCursor === null) {
      return;
    }

    const response = await apiClient.profiles.posts<PaginatedFeedResponse>(profileId, postsCursor);
    setPosts((currentPosts) => appendUniqueFeedPosts(currentPosts, response.items));
    setPostsCursor(response.next_cursor);
  }

  if (isLoading) {
    return (
      <section className="profile-screen profile-state">
        <p className="eyebrow">Profile</p>
        <h1>Loading profile...</h1>
      </section>
    );
  }

  if (profile === null) {
    return (
      <section className="profile-screen profile-state">
        <button className="text-button" onClick={() => navigate(-1)} type="button">
          Back
        </button>
        <p className="eyebrow">Profile</p>
        <h1>Could not load profile</h1>
        <p className="muted-copy">{error ?? 'The profile was not found.'}</p>
      </section>
    );
  }

  return (
    <section className="profile-screen">
      <header className="profile-header">
        <button className="text-button" onClick={() => navigate(-1)} type="button">
          Back
        </button>
        <div className="profile-identity">
          <div className="avatar">
            {profile.avatar_url !== null ? (
              <img
                alt=""
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
                src={profile.avatar_url}
              />
            ) : null}
            <span>{profile.display_name.slice(0, 1).toUpperCase()}</span>
          </div>
          <div>
            <p className="eyebrow">Profile</p>
            <h1>{profile.display_name}</h1>
            <p className="profile-counts">
              {profile.follower_count} followers · {profile.following_count} following
            </p>
          </div>
        </div>
        {profile.id !== currentProfileId ? (
          <button
            className={profile.is_following === true ? 'secondary-button' : 'primary-button'}
            disabled={isUpdatingFollow}
            onClick={() => void toggleProfileFollow()}
            type="button"
          >
            {profile.is_following === true ? 'Following' : 'Follow'}
          </button>
        ) : null}
      </header>

      {error !== null ? <p className="inline-error">{error}</p> : null}

      <div className="profile-grid">
        <section className="profile-panel">
          <p className="eyebrow">About</p>
          {profile.bio !== null ? <p>{profile.bio}</p> : <p className="muted-copy">No bio yet.</p>}
          <div className="interest-row">
            {profile.interests.map((interest) => (
              <span key={interest}>{interest}</span>
            ))}
          </div>
        </section>

        <section className="profile-panel">
          <div className="feed-tabs">
            <button
              className={followListKind === 'followers' ? 'feed-tab feed-tab-active' : 'feed-tab'}
              onClick={() => setFollowListKind('followers')}
              type="button"
            >
              Followers
            </button>
            <button
              className={followListKind === 'following' ? 'feed-tab feed-tab-active' : 'feed-tab'}
              onClick={() => setFollowListKind('following')}
              type="button"
            >
              Following
            </button>
          </div>
          <div className="follow-list">
            {followRows.length === 0 ? (
              <p className="muted-copy">No {followListKind} yet.</p>
            ) : (
              followRows.map((row) => (
                <article className="follow-row" key={row.id}>
                  <button
                    className="text-button"
                    onClick={() => navigate(`/profiles/${row.id}`)}
                    type="button"
                  >
                    {row.display_name}
                  </button>
                  {row.id !== currentProfileId ? (
                    <button
                      className={row.is_following === true ? 'secondary-button' : 'primary-button'}
                      onClick={() => void toggleRowFollow(row)}
                      type="button"
                    >
                      {row.is_following === true ? 'Following' : 'Follow'}
                    </button>
                  ) : null}
                </article>
              ))
            )}
          </div>
          {followCursor !== null ? (
            <button
              className="load-more-button"
              onClick={() => void loadFollowRows({ cursor: followCursor, reset: false })}
              type="button"
            >
              Load more
            </button>
          ) : null}
        </section>

        <section className="profile-panel profile-posts">
          <p className="eyebrow">Posts</p>
          <div className="feed-list">
            {posts.length === 0 ? (
              <p className="muted-copy">No posts yet.</p>
            ) : (
              posts.map((post) => (
                <FeedPostCard
                  key={post.id}
                  post={post}
                  onOpenActivity={(activityId) => navigate(`/activities/${activityId}`)}
                />
              ))
            )}
          </div>
          {postsCursor !== null ? (
            <button className="load-more-button" onClick={() => void loadMorePosts()} type="button">
              Load more posts
            </button>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function YouScreen(): ReactElement {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<PrivateProfile | null>(null);
  const [hostProfile, setHostProfile] = useState<HostProfileRecord | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [interests, setInterests] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const me = await apiClient.profiles.me<PrivateProfile>();
      setProfile(me);
      setDisplayName(me.display_name);
      setBio(me.bio ?? '');
      setInterests(me.interests.join(', '));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load your profile');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function saveProfile(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (profile === null) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const updated = await apiClient.profiles.updateMe<
        Omit<PrivateProfile, 'follower_count' | 'following_count'>
      >({
        displayName: displayName.trim(),
        bio: bio.trim().length === 0 ? null : bio.trim(),
        interests: parseInterests(interests)
      });

      setProfile({ ...profile, ...updated });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save profile');
    } finally {
      setIsSaving(false);
    }
  }

  async function becomeHost(): Promise<void> {
    setIsSaving(true);
    setError(null);

    try {
      const host = await apiClient.profiles.becomeHost<HostProfileRecord>();
      setHostProfile(host);
    } catch (hostError) {
      setError(hostError instanceof Error ? hostError.message : 'Unable to enable host mode');
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <section className="you-screen profile-state">
        <p className="eyebrow">You</p>
        <h1>Loading your profile...</h1>
      </section>
    );
  }

  if (profile === null) {
    return (
      <section className="you-screen profile-state">
        <p className="eyebrow">You</p>
        <h1>Could not load profile</h1>
        <p className="muted-copy">{error ?? 'Try signing in again.'}</p>
      </section>
    );
  }

  return (
    <section className="you-screen">
      <header className="profile-header">
        <div className="profile-identity">
          <div className="avatar">
            {profile.avatar_url !== null ? (
              <img
                alt=""
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                }}
                src={profile.avatar_url}
              />
            ) : null}
            <span>{profile.display_name.slice(0, 1).toUpperCase()}</span>
          </div>
          <div>
            <p className="eyebrow">You</p>
            <h1>{profile.display_name}</h1>
            <p className="profile-counts">
              {profile.follower_count} followers · {profile.following_count} following
            </p>
          </div>
        </div>
        <button className="secondary-button" onClick={() => navigate(`/profiles/${profile.id}`)} type="button">
          Public profile
        </button>
      </header>

      {error !== null ? <p className="inline-error">{error}</p> : null}

      <div className="you-grid">
        <form className="profile-panel profile-form" onSubmit={(event) => void saveProfile(event)}>
          <p className="eyebrow">Profile</p>
          <label>
            Display name
            <input value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} />
          </label>
          <label>
            Bio
            <textarea rows={5} value={bio} onChange={(event) => setBio(event.currentTarget.value)} />
          </label>
          <label>
            Interests
            <input value={interests} onChange={(event) => setInterests(event.currentTarget.value)} />
          </label>
          <button className="primary-button" disabled={isSaving} type="submit">
            Save profile
          </button>
        </form>

        <section className="profile-panel">
          <p className="eyebrow">Host mode</p>
          <p className="muted-copy">
            Become a host when you are ready to publish real capacity and manage explorers.
          </p>
          <button className="secondary-button" disabled={isSaving} onClick={() => void becomeHost()} type="button">
            Become host
          </button>
          {hostProfile !== null ? (
            <p className="inline-success">Host mode enabled · {shortId(hostProfile.id)}</p>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function ActivityDetailScreen(): ReactElement {
  const navigate = useNavigate();
  const { activityId } = useParams();
  const [activity, setActivity] = useState<ActivityDetail | null>(null);
  const [vibe, setVibe] = useState<ActivityVibe | null>(null);
  const [host, setHost] = useState<PublicProfile | null>(null);
  const [activityChat, setActivityChat] = useState<ChatListItem | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [followError, setFollowError] = useState<string | null>(null);
  const [isUpdatingFollow, setIsUpdatingFollow] = useState(false);

  useEffect(() => {
    if (activityId === undefined) {
      setError('Missing activity id');
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const currentActivityId = activityId;

    async function loadActivityDetail(): Promise<void> {
      setIsLoading(true);
      setError(null);
      setFollowError(null);

      try {
        const detail = await apiClient.activities.detail<ActivityDetail>(currentActivityId);
        const [vibeResult, hostProfile, chatItem] = await Promise.all([
          apiClient.activities
            .vibe<ActivityVibe>(currentActivityId)
            .catch((): ActivityVibe | null => null),
          apiClient.profiles.public<PublicProfile>(detail.host_id),
          apiClient.activities
            .chat<ChatListItem>(currentActivityId)
            .catch((): ChatListItem | null => null)
        ]);

        if (!cancelled) {
          setActivity(detail);
          setVibe(vibeResult);
          setHost(hostProfile);
          setActivityChat(chatItem);
        }
      } catch (loadError) {
        if (!cancelled) {
          setActivity(null);
          setVibe(null);
          setHost(null);
          setActivityChat(null);
          setError(loadError instanceof Error ? loadError.message : 'Unable to load activity');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadActivityDetail();

    return () => {
      cancelled = true;
    };
  }, [activityId]);

  async function toggleFollow(): Promise<void> {
    if (host === null || isUpdatingFollow) {
      return;
    }

    const wasFollowing = host.is_following === true;
    const followerDelta = wasFollowing ? -1 : 1;
    const nextHost = {
      ...host,
      is_following: !wasFollowing,
      follower_count: Math.max(0, host.follower_count + followerDelta)
    };

    setHost(nextHost);
    setIsUpdatingFollow(true);
    setFollowError(null);

    try {
      if (wasFollowing) {
        await apiClient.profiles.unfollow<void>(host.id);
      } else {
        await apiClient.profiles.follow<void>(host.id);
      }
    } catch (followUpdateError) {
      setHost(host);
      setFollowError(
        followUpdateError instanceof Error ? followUpdateError.message : 'Could not update follow'
      );
    } finally {
      setIsUpdatingFollow(false);
    }
  }

  if (isLoading) {
    return (
      <section className="detail-screen detail-state">
        <p className="eyebrow">Activity detail</p>
        <h1>Loading hangout...</h1>
      </section>
    );
  }

  if (error !== null || activity === null) {
    return (
      <section className="detail-screen detail-state">
        <button className="text-button" onClick={() => navigate('/map')} type="button">
          Back to map
        </button>
        <p className="eyebrow">Activity detail</p>
        <h1>Could not load this hangout</h1>
        <p className="muted-copy">{error ?? 'The activity was not found.'}</p>
      </section>
    );
  }

  const heroImage = getActivityImage(activity);

  return (
    <section className="detail-screen">
      <div className="detail-hero">
        {heroImage !== null ? (
          <img
            alt={heroImage.alt}
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
            src={heroImage.url}
          />
        ) : null}
        <div className={`detail-hero-fallback detail-hero-${activity.pillar}`}>
          {pillarInitial(activity.pillar)}
        </div>
        <button className="detail-back" onClick={() => navigate('/map')} type="button">
          Back
        </button>
        <div className="detail-hero-copy">
          <p className="eyebrow">{activity.pillar} · {activity.category}</p>
          <h1>{activity.title}</h1>
          <p>{activity.meeting_point}</p>
        </div>
      </div>

      <div className="detail-grid">
        <article className="detail-main">
          <p className="detail-description">{activity.description}</p>
          <section className="detail-section">
            <div className="section-heading">
              <p className="eyebrow">Slots</p>
              <h2>Choose when to join</h2>
            </div>
            <div className="slot-list">
              {activity.upcoming_open_slots.length === 0 ? (
                <p className="muted-copy">No open slots right now.</p>
              ) : (
                activity.upcoming_open_slots.map((slot) => (
                  <article className="slot-card" key={slot.id}>
                    <div>
                      <strong>{formatSlotDateRange(slot.starts_at, slot.ends_at)}</strong>
                      <span>
                        {slot.capacity - slot.booked_count} of {slot.capacity} spots open
                      </span>
                    </div>
                    <div className="slot-meta">
                      <b>{formatInr(activity.base_price_inr)}</b>
                      <button
                        className="primary-button"
                        data-testid="slot-join-button"
                        onClick={() =>
                          navigate(`/activities/${activity.id}/join?slotId=${slot.id}`, {
                            state: { activityId: activity.id, slotId: slot.id }
                          })
                        }
                        type="button"
                      >
                        Join
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className="detail-section">
            <div className="section-heading">
              <p className="eyebrow">Fairness</p>
              <h2>Price and capacity</h2>
            </div>
            <div className="fairness-card">
              <div className="fairness-row">
                <span>Fairness meter</span>
                <strong>{Math.round(activity.fairness.score)}/100</strong>
              </div>
              <div className="fairness-track" aria-label={`Fairness score ${activity.fairness.score}`}>
                <span style={{ width: `${clampPercent(activity.fairness.score)}%` }} />
              </div>
              <p>{activity.fairness.suggestion}</p>
              <small>
                Capacity {activity.capacity} · Category median{' '}
                {activity.fairness.category_median_inr === null
                  ? 'not enough data'
                  : formatInr(activity.fairness.category_median_inr)}
              </small>
            </div>
          </section>

          <section className="maidan-way">
            <p className="eyebrow">The Maidan way</p>
            <p>
              Show up on time, respect the group pace, and leave the place better than you found
              it.
            </p>
          </section>
        </article>

        <aside className="detail-side">
          {activityChat !== null ? (
            <section className="host-card">
              <p className="eyebrow">Group chat</p>
              <h2>{activityChat.chat.title}</h2>
              <button
                className="primary-button"
                data-testid="activity-detail-chat-button"
                onClick={() => openChatFromSummary(navigate, activityChat)}
                type="button"
              >
                Open chat
              </button>
            </section>
          ) : null}

          {host !== null ? (
            <section className="host-card">
              <div className="host-row">
                <div className="avatar">
                  {host.avatar_url !== null ? (
                    <img
                      alt=""
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                      }}
                      src={host.avatar_url}
                    />
                  ) : null}
                  <span>{host.display_name.slice(0, 1).toUpperCase()}</span>
                </div>
                <div>
                  <p className="eyebrow">Host</p>
                  <h2>{host.display_name}</h2>
                  <span>{host.follower_count} followers</span>
                </div>
              </div>
              {host.bio !== null ? <p>{host.bio}</p> : null}
              <div className="interest-row">
                {host.interests.slice(0, 4).map((interest) => (
                  <span key={interest}>{interest}</span>
                ))}
              </div>
              <button
                className={host.is_following === true ? 'secondary-button' : 'primary-button'}
                data-testid="host-follow-button"
                disabled={isUpdatingFollow}
                onClick={() => void toggleFollow()}
                type="button"
              >
                {isUpdatingFollow
                  ? 'Updating...'
                  : host.is_following === true
                  ? 'Following'
                  : 'Follow'}
              </button>
              <button
                className="secondary-button"
                onClick={() => navigate(`/profiles/${host.id}`)}
                type="button"
              >
                View profile
              </button>
              {followError !== null ? <p className="inline-error">{followError}</p> : null}
            </section>
          ) : null}

          <section className="vibe-card">
            <p className="eyebrow">Vibe</p>
            {vibe === null ? (
              <p className="muted-copy">Vibe is settling in.</p>
            ) : (
              <>
                <strong>{vibe.participant_count} people in the circle</strong>
                <p>{vibe.summary}</p>
                <div className="people-list">
                  {vibe.people.map((person) => (
                    <span key={`${person.role}-${person.display_name}`}>
                      {person.display_name} · {person.role}
                    </span>
                  ))}
                </div>
                <div className="interest-row">
                  {vibe.shared_interests.map((interest) => (
                    <span key={interest.tag}>
                      {interest.tag} × {interest.count}
                    </span>
                  ))}
                </div>
              </>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

type JoinStep = 'loading' | 'ready' | 'booking' | 'payment' | 'waiting' | 'confirmed' | 'error';

function JoinFlowScreen(): ReactElement {
  const navigate = useNavigate();
  const { activityId } = useParams();
  const [searchParams] = useSearchParams();
  const slotId = searchParams.get('slotId');
  const [activity, setActivity] = useState<ActivityDetail | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<ActivitySlot | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [chat, setChat] = useState<GroupChat | null>(null);
  const [step, setStep] = useState<JoinStep>('loading');
  const [error, setError] = useState<string | null>(null);
  const [bookingConfirmed, setBookingConfirmed] = useState(false);
  const [chatJoined, setChatJoined] = useState(false);

  useEffect(() => {
    if (activityId === undefined || slotId === null) {
      setStep('error');
      setError('Choose an open slot before booking.');
      return;
    }

    let cancelled = false;
    const currentActivityId = activityId;
    const currentSlotId = slotId;

    async function loadJoinContext(): Promise<void> {
      setStep('loading');
      setError(null);

      try {
        const detail = await apiClient.activities.detail<ActivityDetail>(currentActivityId);
        const slot =
          detail.upcoming_open_slots.find((candidate) => candidate.id === currentSlotId) ?? null;

        if (!cancelled) {
          setActivity(detail);
          setSelectedSlot(slot);
          setStep(slot === null ? 'error' : 'ready');
          setError(slot === null ? 'This slot is no longer open.' : null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setStep('error');
          setError(loadError instanceof Error ? loadError.message : 'Unable to load this slot');
        }
      }
    }

    void loadJoinContext();

    return () => {
      cancelled = true;
    };
  }, [activityId, slotId]);

  useEffect(() => {
    realtimeClient.connect();

    const offBookingConfirmed = realtimeClient.on('booking:confirmed', (payload) => {
      const bookingId = readStringField(payload.booking, 'booking_id') ?? readStringField(payload.booking, 'id');

      if (booking !== null && bookingId === booking.id) {
        setBookingConfirmed(true);
        setChat(payload.chat);
      }
    });
    const offChatJoined = realtimeClient.on('chat:joined', (payload) => {
      if (activity !== null && payload.chat.activity_id === activity.id) {
        setChatJoined(true);
        setChat(payload.chat);
      }
    });

    return () => {
      offBookingConfirmed();
      offChatJoined();
    };
  }, [activity, booking]);

  useEffect(() => {
    if (!bookingConfirmed || !chatJoined || chat === null || activity === null) {
      return undefined;
    }

    setStep('confirmed');
    const timer = window.setTimeout(() => {
      storeJoinedChatState({ activityId: activity.id, chat });
      navigate(`/chats/${chat.id}?activityId=${activity.id}`, {
        replace: true,
        state: { activityId: activity.id, chat } satisfies JoinedChatState
      });
    }, 800);

    return () => window.clearTimeout(timer);
  }, [activity, bookingConfirmed, chat, chatJoined, navigate]);

  async function bookSelectedSlot(): Promise<void> {
    if (selectedSlot === null || step === 'booking' || step === 'payment' || step === 'waiting') {
      return;
    }

    setStep('booking');
    setError(null);

    try {
      const created = await apiClient.bookings.create<CreateBookingResponse>({
        headcount: 1,
        slotId: selectedSlot.id
      });
      setBooking(created.booking);

      const initiated = await apiClient.payments.init<InitPaymentResponse>({
        bookingId: created.booking.id
      });
      setPayment(initiated.payment);
      setStep(initiated.already_paid ? 'waiting' : 'payment');

      if (initiated.already_paid) {
        setBookingConfirmed(true);
      }
    } catch (bookingError) {
      setStep('error');
      setError(toJoinErrorMessage(bookingError));
    }
  }

  async function completeFakePayment(): Promise<void> {
    if (payment === null || step === 'waiting') {
      return;
    }

    setStep('waiting');
    setError(null);

    try {
      const webhook = await apiClient.payments.completeFake<PaymentWebhookResponse>(
        createFakePaymentWebhook(payment),
        await createFakeWebhookAuthorization()
      );

      if (webhook.terminal_status === 'failed') {
        setStep('error');
        setError('Payment failed. No spot was confirmed.');
        return;
      }

      if (!webhook.received) {
        setStep('error');
        setError('Payment confirmation was not accepted.');
      }
    } catch (paymentError) {
      setStep('error');
      setError(paymentError instanceof Error ? paymentError.message : 'Payment failed');
    }
  }

  if (step === 'loading') {
    return (
      <section className="join-screen join-state">
        <p className="eyebrow">Join</p>
        <h1>Preparing your spot...</h1>
      </section>
    );
  }

  if (activity === null || selectedSlot === null) {
    return (
      <section className="join-screen join-state">
        <button className="text-button" onClick={() => navigate(-1)} type="button">
          Back
        </button>
        <p className="eyebrow">Join</p>
        <h1>Could not start booking</h1>
        <p className="muted-copy">{error ?? 'This slot is unavailable.'}</p>
      </section>
    );
  }

  return (
    <section className="join-screen">
      <button className="text-button" onClick={() => navigate(`/activities/${activity.id}`)} type="button">
        Back to detail
      </button>
      <div className="join-grid">
        <article className="join-card">
          <p className="eyebrow">Join</p>
          <h1>{activity.title}</h1>
          <p className="muted-copy">{formatSlotDateRange(selectedSlot.starts_at, selectedSlot.ends_at)}</p>
          <div className="join-summary">
            <span>1 spot</span>
            <strong>{formatInr(activity.base_price_inr)}</strong>
          </div>
          <div className="maidan-way">
            <p className="eyebrow">The Maidan way</p>
            <p>Pay only when you mean it. The host holds capacity for you once payment lands.</p>
          </div>
          {booking !== null ? (
            <div className="join-receipt">
              <span>Booking</span>
              <b>{booking.status}</b>
            </div>
          ) : null}
          {payment !== null ? (
            <div className="join-receipt">
              <span>Payment</span>
              <b>{payment.status}</b>
            </div>
          ) : null}
          {error !== null ? <p className="form-error">{error}</p> : null}
          {step === 'ready' || step === 'error' || step === 'booking' ? (
            <button
              className="primary-button"
              data-testid="book-spot-button"
              disabled={step === 'booking'}
              onClick={() => void bookSelectedSlot()}
              type="button"
            >
              {step === 'booking' ? 'Booking...' : 'Book spot'}
            </button>
          ) : null}
          {step === 'payment' ? (
            <button
              className="primary-button"
              data-testid="complete-fake-payment-button"
              onClick={() => void completeFakePayment()}
              type="button"
            >
              Complete payment (fake)
            </button>
          ) : null}
          {step === 'waiting' ? (
            <p className="join-waiting">Waiting for booking confirmation and chat invite...</p>
          ) : null}
          {step === 'confirmed' ? (
            <p className="join-confirmed">Payment confirmed. Opening your group chat...</p>
          ) : null}
        </article>
      </div>
    </section>
  );
}

function ChatRoomScreen(): ReactElement {
  const { chatId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const joinedState =
    getJoinedChatState(location.state) ??
    (chatId === undefined ? null : getStoredJoinedChatState(chatId));
  const activityId =
    joinedState?.activityId ?? joinedState?.chat.activity_id ?? searchParams.get('activityId');
  const currentProfileId = getCurrentProfileId();
  const [activity, setActivity] = useState<ActivityDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatMembers, setChatMembers] = useState<ChatMemberSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [hasJoinedRoom, setHasJoinedRoom] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlineProfileIds, setOnlineProfileIds] = useState<Set<string>>(
    () => new Set(currentProfileId === null ? [] : [currentProfileId])
  );
  const [typingProfileIds, setTypingProfileIds] = useState<Set<string>>(() => new Set());
  const isTypingRef = useRef(false);
  const typingStopTimerRef = useRef<number | null>(null);
  const typingTimersRef = useRef<Map<string, number>>(new Map());
  const isHost = activity !== null && currentProfileId === activity.host_id;
  const chatTitle = joinedState?.chat.title ?? activity?.title ?? 'Activity chat';

  const loadMessages = useCallback(
    async ({ cursor, reset }: { cursor?: string | null; reset: boolean }) => {
      if (chatId === undefined) {
        setError('Missing chat id');
        setIsLoading(false);
        return;
      }

      if (reset) {
        setIsLoading(true);
        setMessages([]);
        setNextCursor(null);
      } else {
        setIsLoadingMore(true);
      }

      setError(null);

      try {
        const response = await apiClient.chats.messages<PaginatedMessagesResponse>(
          chatId,
          cursor ?? undefined
        );
        const chronologicalMessages = response.items.slice().reverse();

        setMessages((currentMessages) =>
          reset
            ? chronologicalMessages
            : prependUniqueMessages(currentMessages, chronologicalMessages)
        );
        setNextCursor(response.next_cursor);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load chat');
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [chatId]
  );

  useEffect(() => {
    if (joinedState !== null) {
      storeJoinedChatState(joinedState);
    }
  }, [joinedState]);

  useEffect(() => {
    void loadMessages({ reset: true });
  }, [loadMessages]);

  useEffect(() => {
    if (chatId === undefined) {
      setChatMembers([]);
      return undefined;
    }

    let cancelled = false;

    apiClient.chats
      .members<ChatMemberSummary>(chatId)
      .then((members) => {
        if (!cancelled) {
          setChatMembers(members);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChatMembers([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  useEffect(() => {
    if (activityId === null) {
      setActivity(null);
      return undefined;
    }

    let cancelled = false;

    apiClient.activities
      .detail<ActivityDetail>(activityId)
      .then((detail) => {
        if (!cancelled) {
          setActivity(detail);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setActivity(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activityId]);

  const stopTyping = useCallback(() => {
    if (typingStopTimerRef.current !== null) {
      window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
    }

    if (chatId !== undefined && isTypingRef.current) {
      isTypingRef.current = false;
      void realtimeClient.sendTyping(chatId, false);
    }
  }, [chatId]);

  useEffect(() => {
    if (chatId === undefined) {
      return undefined;
    }

    realtimeClient.connect();
    setAccessLost(false);
    setHasJoinedRoom(false);
    setOnlineProfileIds(new Set(currentProfileId === null ? [] : [currentProfileId]));
    setTypingProfileIds(new Set());

    let active = true;
    void realtimeClient.joinChat(chatId).then((ack) => {
      if (!active) {
        return;
      }

      if (ack.ok) {
        setHasJoinedRoom(true);
      } else {
        setError(ack.error ?? 'Could not join chat room');
      }
    });

    const offMessage = realtimeClient.on('message:new', (message) => {
      if (message.chat_id !== chatId) {
        return;
      }

      setMessages((currentMessages) => appendUniqueMessages(currentMessages, [message]));
      clearTypingProfile(message.sender_id, typingTimersRef.current, setTypingProfileIds);
    });
    const offPresence = realtimeClient.on('presence', (payload) => {
      if (payload.chatId !== undefined && payload.chatId !== chatId) {
        return;
      }

      setOnlineProfileIds((currentProfileIds) => {
        const nextProfileIds = new Set(currentProfileIds);

        if (payload.status === 'online') {
          nextProfileIds.add(payload.profileId);
        } else {
          nextProfileIds.delete(payload.profileId);
        }

        return nextProfileIds;
      });
    });
    const offTyping = realtimeClient.on('typing', (payload) => {
      if (payload.chatId !== chatId || payload.profileId === currentProfileId) {
        return;
      }

      if (payload.isTyping) {
        setTypingProfileIds((currentProfileIds) => new Set(currentProfileIds).add(payload.profileId));
        const existingTimer = typingTimersRef.current.get(payload.profileId);

        if (existingTimer !== undefined) {
          window.clearTimeout(existingTimer);
        }

        typingTimersRef.current.set(
          payload.profileId,
          window.setTimeout(() => {
            clearTypingProfile(payload.profileId, typingTimersRef.current, setTypingProfileIds);
          }, 2500)
        );
      } else {
        clearTypingProfile(payload.profileId, typingTimersRef.current, setTypingProfileIds);
      }
    });
    const offMemberRemoved = realtimeClient.on('chat:member_removed', (payload) => {
      if (payload.chatId !== chatId) {
        return;
      }

      setChatMembers((currentMembers) =>
        currentMembers.filter((member) => member.profile_id !== payload.profileId)
      );
      setOnlineProfileIds((currentProfileIds) => {
        const nextProfileIds = new Set(currentProfileIds);
        nextProfileIds.delete(payload.profileId);
        return nextProfileIds;
      });
      clearTypingProfile(payload.profileId, typingTimersRef.current, setTypingProfileIds);

      if (payload.profileId === currentProfileId) {
        setAccessLost(true);
        setHasJoinedRoom(false);
        setChatMembers([]);
        setDraft('');
        setError('You no longer have access to this group chat.');
        stopTyping();
      }
    });

    return () => {
      active = false;
      stopTyping();
      realtimeClient.leaveChat(chatId);
      offMessage();
      offPresence();
      offTyping();
      offMemberRemoved();
      for (const timer of typingTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      typingTimersRef.current.clear();
    };
  }, [chatId, currentProfileId, stopTyping]);

  function updateDraft(value: string): void {
    setDraft(value);

    if (chatId === undefined || accessLost) {
      return;
    }

    if (!isTypingRef.current && value.trim().length > 0) {
      isTypingRef.current = true;
      void realtimeClient.sendTyping(chatId, true);
    }

    if (typingStopTimerRef.current !== null) {
      window.clearTimeout(typingStopTimerRef.current);
    }

    typingStopTimerRef.current = window.setTimeout(stopTyping, 1400);
  }

  async function sendChatMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (chatId === undefined || isSending || !hasJoinedRoom || accessLost) {
      return;
    }

    const body = draft.trim();

    if (body.length === 0) {
      return;
    }

    setIsSending(true);
    setError(null);

    try {
      const ack = await realtimeClient.sendMessage(chatId, body);

      if (!ack.ok) {
        setError(ack.error ?? 'Message could not be sent');
        return;
      }

      const sentMessage = ack.message;

      if (sentMessage !== undefined) {
        setMessages((currentMessages) => appendUniqueMessages(currentMessages, [sentMessage]));
      }

      setDraft('');
      stopTyping();
    } finally {
      setIsSending(false);
    }
  }

  if (chatId === undefined) {
    return (
      <section className="chat-screen chat-state">
        <p className="eyebrow">Group chat</p>
        <h1>Missing chat</h1>
        <p className="muted-copy">Open a chat from a confirmed booking.</p>
      </section>
    );
  }

  return (
    <section className="chat-screen">
      <header className="chat-header">
        <button className="text-button" onClick={() => navigate(-1)} type="button">
          Back
        </button>
        <div>
          <p className="eyebrow">{isHost ? 'Host chat' : 'Group chat'}</p>
          <h1>{chatTitle}</h1>
          <p className="chat-presence">
            {onlineProfileIds.size === 0
              ? 'No one else is live right now'
              : `${onlineProfileIds.size} live now`}
            {typingProfileIds.size > 0
              ? ` · ${formatTypingProfiles(typingProfileIds)} typing`
              : ''}
          </p>
        </div>
        {isHost && activity !== null ? (
          <button
            aria-label="Manage activity"
            className="chat-info-button"
            onClick={() => navigate(`/activities/${activity.id}/manage`)}
            type="button"
          >
            ⓘ
          </button>
        ) : (
          <span className="member-pill">Member view</span>
        )}
      </header>

      {error !== null ? <p className="inline-error">{error}</p> : null}

      {chatMembers.length > 0 ? (
        <div className="chat-member-strip" data-testid="chat-member-list">
          {chatMembers.map((member) => (
            <span className="chat-member-chip" key={member.profile_id}>
              {member.display_name}
              <small>
                {member.role}
                {onlineProfileIds.has(member.profile_id) ? ' · live' : ''}
              </small>
            </span>
          ))}
        </div>
      ) : null}

      <div className="chat-message-list" data-testid="chat-message-list" aria-live="polite">
        {nextCursor !== null ? (
          <button
            className="load-more-button"
            disabled={isLoadingMore}
            onClick={() => void loadMessages({ cursor: nextCursor, reset: false })}
            type="button"
          >
            {isLoadingMore ? 'Loading...' : 'Load earlier messages'}
          </button>
        ) : null}
        {isLoading && messages.length === 0 ? <p className="feed-loading">Loading chat...</p> : null}
        {!isLoading && messages.length === 0 && error === null ? (
          <div className="chat-empty">
            <p className="eyebrow">Group chat</p>
            <h2>Start the thread</h2>
            <p className="muted-copy">Messages from this activity group will appear here.</p>
          </div>
        ) : null}
        {messages.map((message) => {
          const isOwnMessage = message.sender_id === currentProfileId;

          return (
            <article
              className={isOwnMessage ? 'chat-message chat-message-own' : 'chat-message'}
              key={message.id}
            >
              <span>{isOwnMessage ? 'You' : `Member ${shortId(message.sender_id)}`}</span>
              <p>{message.body}</p>
              <time dateTime={message.created_at}>{formatFeedDate(message.created_at)}</time>
            </article>
          );
        })}
      </div>

      <form className="chat-compose" onSubmit={(event) => void sendChatMessage(event)}>
        <label htmlFor="chat-message">Message</label>
        <textarea
          data-testid="chat-message-input"
          id="chat-message"
          disabled={accessLost || !hasJoinedRoom}
          onChange={(event) => updateDraft(event.currentTarget.value)}
          placeholder="Write to the group"
          rows={2}
          value={draft}
        />
        <button
          className="primary-button"
          data-testid="send-chat-message-button"
          disabled={isSending || !hasJoinedRoom || accessLost || draft.trim().length === 0}
          type="submit"
        >
          {isSending ? 'Sending...' : 'Send'}
        </button>
      </form>
    </section>
  );
}

function getJoinedChatState(state: unknown): JoinedChatState | null {
  if (typeof state !== 'object' || state === null || !('chat' in state) || !('activityId' in state)) {
    return null;
  }

  const candidate = state as { activityId?: unknown; chat?: Partial<GroupChat> };

  if (
    typeof candidate.activityId !== 'string' ||
    typeof candidate.chat?.id !== 'string' ||
    typeof candidate.chat.activity_id !== 'string' ||
    typeof candidate.chat.title !== 'string' ||
    typeof candidate.chat.created_at !== 'string'
  ) {
    return null;
  }

  return {
    activityId: candidate.activityId,
    chat: candidate.chat as GroupChat
  };
}

function getStoredJoinedChatState(chatId: string): JoinedChatState | null {
  try {
    const rawValue = window.sessionStorage.getItem(joinedChatsStorageKey);

    if (rawValue === null) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as unknown;

    if (typeof parsed !== 'object' || parsed === null || !(chatId in parsed)) {
      return null;
    }

    return getJoinedChatState((parsed as Record<string, unknown>)[chatId]);
  } catch {
    return null;
  }
}

function storeJoinedChatState(state: JoinedChatState): void {
  try {
    const rawValue = window.sessionStorage.getItem(joinedChatsStorageKey);
    const parsed = rawValue === null ? {} : (JSON.parse(rawValue) as unknown);
    const storedChats =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};

    storedChats[state.chat.id] = state;
    window.sessionStorage.setItem(joinedChatsStorageKey, JSON.stringify(storedChats));
  } catch {
    // Session storage can be unavailable in private or restricted browser contexts.
  }
}

function openChatFromSummary(navigate: NavigateFunction, chatItem: ChatListItem): void {
  const state: JoinedChatState = {
    activityId: chatItem.activity.id,
    chat: chatItem.chat
  };

  storeJoinedChatState(state);
  navigate(`/chats/${chatItem.chat.id}?activityId=${chatItem.activity.id}`, { state });
}

function appendUniqueMessages(
  currentMessages: ChatMessage[],
  nextMessages: CompactMessage[]
): ChatMessage[] {
  const seenIds = new Set(currentMessages.map((message) => message.id));
  const uniqueNextMessages = nextMessages.filter((message) => !seenIds.has(message.id));

  return [...currentMessages, ...uniqueNextMessages];
}

function prependUniqueMessages(
  currentMessages: ChatMessage[],
  olderMessages: ChatMessage[]
): ChatMessage[] {
  const seenIds = new Set(currentMessages.map((message) => message.id));
  const uniqueOlderMessages = olderMessages.filter((message) => !seenIds.has(message.id));

  return [...uniqueOlderMessages, ...currentMessages];
}

function clearTypingProfile(
  profileId: string,
  timers: Map<string, number>,
  setTypingProfileIds: (updater: (currentProfileIds: Set<string>) => Set<string>) => void
): void {
  const timer = timers.get(profileId);

  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(profileId);
  }

  setTypingProfileIds((currentProfileIds) => {
    const nextProfileIds = new Set(currentProfileIds);
    nextProfileIds.delete(profileId);

    return nextProfileIds;
  });
}

function formatTypingProfiles(profileIds: Set<string>): string {
  const labels = Array.from(profileIds)
    .slice(0, 2)
    .map((profileId) => shortId(profileId));

  if (profileIds.size > 2) {
    labels.push(`+${profileIds.size - 2}`);
  }

  return labels.join(', ');
}

function getCurrentProfileId(): string | null {
  const accessToken = getAuthTokens()?.accessToken;

  if (accessToken === undefined) {
    return null;
  }

  return readJwtSubject(accessToken);
}

function readJwtSubject(token: string): string | null {
  const [, payload] = token.split('.');

  if (payload === undefined) {
    return null;
  }

  try {
    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
      '='
    );
    const parsed = JSON.parse(window.atob(paddedPayload)) as unknown;

    return readStringField(parsed, 'sub');
  } catch {
    return null;
  }
}

function getActivityImage(activity: ActivityDetail): { url: string; alt: string } | null {
  for (const item of activity.media) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }

    const media = item as Record<string, unknown>;

    if (media.type === 'image' && typeof media.url === 'string') {
      return {
        url: media.url,
        alt: typeof media.alt === 'string' ? media.alt : activity.title
      };
    }
  }

  return null;
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

function formatSlotDateRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const date = start.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    weekday: 'short'
  });
  const startTime = start.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  });
  const endTime = end.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  });

  return `${date} · ${startTime} - ${endTime}`;
}

function formatInr(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    currency: 'INR',
    maximumFractionDigits: 0,
    style: 'currency'
  }).format(amount);
}

const defaultActivityLocation: GeoPoint = { lat: 13.3702, lng: 77.6835 };

function parseComposerLocation(lat: string, lng: string): GeoPoint | null {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);

  if (
    !Number.isFinite(parsedLat) ||
    !Number.isFinite(parsedLng) ||
    parsedLat < -90 ||
    parsedLat > 90 ||
    parsedLng < -180 ||
    parsedLng > 180
  ) {
    return null;
  }

  return { lat: parsedLat, lng: parsedLng };
}

function formatCoordinate(value: number): string {
  return value.toFixed(6);
}

function defaultActivityComposerState(): ActivityComposerState {
  const start = new Date();
  start.setDate(start.getDate() + 10);
  start.setHours(6, 30, 0, 0);
  const end = new Date(start);
  end.setHours(start.getHours() + 2);

  return {
    title: 'Nandi Hills sunrise mobility circle',
    description:
      'A small, steady group session with warm-up drills, a scenic loop, and a clear regroup point.',
    pillar: 'move',
    category: 'mobility',
    meetingPoint: 'Nandi Hills base parking, near the ticket counter',
    lat: '13.3702',
    lng: '77.6835',
    basePriceInr: '799',
    capacity: '8',
    startsAt: toDatetimeLocalValue(start),
    endsAt: toDatetimeLocalValue(end)
  };
}

function toActivityPillar(value: string): ActivityPillar {
  if (value === 'learn' || value === 'feel') {
    return value;
  }

  return 'move';
}

function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function datetimeLocalToIso(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error('Choose a valid slot time');
  }

  return date.toISOString();
}

function appendUniqueFeedPosts(currentPosts: FeedPost[], nextPosts: FeedPost[]): FeedPost[] {
  const seenIds = new Set(currentPosts.map((post) => post.id));
  const uniqueNextPosts = nextPosts.filter((post) => !seenIds.has(post.id));

  return [...currentPosts, ...uniqueNextPosts];
}

function appendUniqueFollowRows(
  currentRows: FollowProfileSummary[],
  nextRows: FollowProfileSummary[]
): FollowProfileSummary[] {
  const seenIds = new Set(currentRows.map((row) => row.id));
  const uniqueNextRows = nextRows.filter((row) => !seenIds.has(row.id));

  return [...currentRows, ...uniqueNextRows];
}

function parseInterests(value: string): string[] {
  return value
    .split(',')
    .map((interest) => interest.trim())
    .filter((interest) => interest.length > 0);
}

async function streamSutradharReply(
  message: string,
  sessionId: string,
  onDelta: (text: string) => void
): Promise<SutradharFinalEvent> {
  const response = await apiClient.sutradhar.chatStream({ message, sessionId });

  if (response.body === null) {
    throw new Error('Sutradhar response was empty');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalEvent: SutradharFinalEvent | null = null;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    buffer = consumeSutradharEvents(buffer, (event) => {
      if (event.type === 'delta') {
        onDelta(event.text ?? '');
      } else {
        finalEvent = event;
      }
    });
  }

  buffer += decoder.decode();
  consumeSutradharEvents(`${buffer}\n\n`, (event) => {
    if (event.type === 'delta') {
      onDelta(event.text ?? '');
    } else {
      finalEvent = event;
    }
  });

  if (finalEvent === null) {
    return { type: 'final', activity_ids: [] };
  }

  return finalEvent;
}

function consumeSutradharEvents(
  buffer: string,
  onEvent: (event: SutradharStreamEvent) => void
): string {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = blocks.pop() ?? '';

  for (const block of blocks) {
    const event = parseSutradharEvent(block);

    if (event !== null) {
      onEvent(event);
    }
  }

  return remainder;
}

function parseSutradharEvent(block: string): SutradharStreamEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');

  if (data.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as Partial<SutradharStreamEvent>;

    if (parsed.type === 'delta' || parsed.type === 'final') {
      return parsed as SutradharStreamEvent;
    }
  } catch {
    return null;
  }

  return null;
}

async function loadSutradharOptions(activityIds: string[]): Promise<ActivityDetail[]> {
  const uniqueActivityIds = Array.from(new Set(activityIds)).slice(0, 3);
  const options = await Promise.all(
    uniqueActivityIds.map((activityId) =>
      apiClient.activities.detail<ActivityDetail>(activityId).catch((): ActivityDetail | null => null)
    )
  );

  return options.filter((activity): activity is ActivityDetail => activity !== null);
}

function formatFeedDate(createdAt: string): string {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  return date.toLocaleString(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short'
  });
}

function formatFeedActivitySlot(
  slot: NonNullable<FeedPost['linked_activity']>['next_slot']
): string {
  if (slot === null) {
    return 'Next slot opening soon';
  }

  return formatSlotDateRange(slot.starts_at, slot.ends_at);
}

function formatPillarLabel(pillar: ActivityPillar): string {
  return `${pillar.slice(0, 1).toUpperCase()}${pillar.slice(1)}`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function readStringField(value: unknown, field: string): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[field];

  return typeof candidate === 'string' ? candidate : null;
}

function toJoinErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Booking could not be completed';

  if (message.includes('Slot capacity exceeded')) {
    return 'This slot just filled up. Pick another open slot.';
  }

  if (message.includes('Slot is not open') || message.includes('Slot not found')) {
    return 'This slot is no longer available.';
  }

  if (message.includes('Booking payment is already terminal')) {
    return 'This booking already has a completed payment attempt.';
  }

  return message;
}

function createFakePaymentWebhook(payment: Payment): Record<string, unknown> {
  return {
    event: 'checkout.order.completed',
    payload: {
      merchantOrderId: payment.phonepe_order_id,
      state: 'COMPLETED',
      amount: payment.amount_inr * 100,
      paymentDetails: [
        {
          transactionId: `WEB-FAKE-${payment.id}-${Date.now()}`
        }
      ]
    }
  };
}

async function createFakeWebhookAuthorization(): Promise<string> {
  const credential =
    import.meta.env.VITE_FAKE_PHONEPE_WEBHOOK_CREDENTIAL ??
    'local-phonepe-webhook-user:local-phonepe-webhook-password';

  if (globalThis.crypto?.subtle === undefined) {
    throw new Error('Browser crypto is required for fake payment completion');
  }

  const bytes = new TextEncoder().encode(credential);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
