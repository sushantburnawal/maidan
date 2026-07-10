import { buildNearbySqlParts, nearbyOrderSql } from '../src/activities/activities.repository';

describe('buildNearbySqlParts', () => {
  it('casts the map-bounds ordering radius to float8', () => {
    const parts = buildNearbySqlParts({
      north: 13.5,
      south: 12.7,
      east: 78,
      west: 77.3,
      radius_km: 10
    });

    expect(parts.orderRadiusParameter).toBe(7);
    expect(parts.values[6]).toEqual(expect.any(Number));
    expect(parts.values[6]).not.toBe(Math.trunc(parts.values[6] as number));
    expect(parts.distanceSql).toContain('$5');
    expect(parts.distanceSql).toContain('$6');
    expect(nearbyOrderSql(parts.distanceSql, parts.orderRadiusParameter)).toContain(
      'greatest($7::float8, 1::float8)'
    );
  });
});
