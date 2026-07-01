export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface PrivateProfileRecord {
  id: string;
  phone: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  interests: string[];
  home_location: GeoPoint | null;
  created_at: string;
  updated_at: string;
}

export type PublicProfileRecord = Omit<
  PrivateProfileRecord,
  'phone' | 'created_at' | 'updated_at'
>;

export interface FollowCountFields {
  follower_count: number;
  following_count: number;
}

export type PrivateProfileResponse = PrivateProfileRecord & FollowCountFields;

export type PublicProfileResponse = PublicProfileRecord &
  FollowCountFields & {
    is_following?: boolean;
  };

export interface HostProfileRecord {
  id: string;
  profile_id: string;
  is_verified: boolean;
  payout_ref: string | null;
  rating: number;
  total_activities: number;
  created_at: string;
  updated_at: string;
}

export interface UpdateProfileInput {
  display_name?: string;
  bio?: string | null;
  interests?: string[];
  avatar_url?: string | null;
  home_location?: GeoPoint | null;
}

export interface ProfilesApiRepository {
  getPrivateProfile(profileId: string): Promise<PrivateProfileRecord | undefined>;
  updatePrivateProfile(
    profileId: string,
    input: UpdateProfileInput
  ): Promise<PrivateProfileRecord | undefined>;
  getPublicProfile(profileId: string): Promise<PublicProfileRecord | undefined>;
  becomeHost(profileId: string): Promise<HostProfileRecord | undefined>;
}
