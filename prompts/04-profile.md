Implement a `profiles` module: GET /me, PATCH /me (display_name, bio, interests, avatar_url,
home_location as {lat,lng}), GET /profiles/:id (public subset). Add POST /me/become-host which
creates a host_profiles row (idempotent). All writes scoped to @CurrentUser. Validate home_location
and store as geography(Point,4326). DoD: e2e covers update + become-host idempotency + public view
hides phone.