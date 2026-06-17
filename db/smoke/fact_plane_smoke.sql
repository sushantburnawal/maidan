begin;

select st_dwithin(
  st_setsrid(st_makepoint(77.5946, 12.9716), 4326)::geography,
  st_setsrid(st_makepoint(77.6046, 12.9816), 4326)::geography,
  2000
) as postgis_st_dwithin_runs;

with query_embedding as (
  select (
    '[' || array_to_string(array_prepend(1::real, array_fill(0::real, array[767])), ',') || ']'
  )::vector(768) as value
)
select value <=> value as vector_cosine_distance_runs
from query_embedding;

with query_embedding as (
  select (
    '[' || array_to_string(array_prepend(1::real, array_fill(0::real, array[767])), ',') || ']'
  )::vector(768) as value
)
select id
from activities, query_embedding
where embedding is not null
order by embedding <=> query_embedding.value
limit 1;

rollback;
