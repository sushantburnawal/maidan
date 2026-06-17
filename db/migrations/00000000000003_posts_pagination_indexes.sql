create index posts_created_at_id_idx on posts (created_at desc, id desc);
create index posts_author_id_created_at_id_idx on posts (author_id, created_at desc, id desc);
