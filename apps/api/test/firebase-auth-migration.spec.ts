import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Firebase Google auth migration', () => {
  const migration = readFileSync(
    join(__dirname, '../../../db/migrations/00000000000008_firebase_google_auth.sql'),
    'utf8'
  );

  it('allows Google profiles without fake phone numbers', () => {
    expect(migration).toContain('alter column phone drop not null');
    expect(migration).toContain('add column if not exists firebase_uid text');
    expect(migration).toContain('add column if not exists email text');
    expect(migration).toContain('phone is not null or firebase_uid is not null');
  });

  it('keeps Firebase identity unique when present', () => {
    expect(migration).toContain('profiles_firebase_uid_key');
    expect(migration).toContain('where firebase_uid is not null');
    expect(migration).toContain('profiles_email_lower_key');
    expect(migration).toContain('lower(email)');
  });
});
