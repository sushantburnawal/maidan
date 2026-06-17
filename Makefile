COMPOSE_FILE := infra/docker-compose.local.yml
POSTGRES_USER ?= postgres
POSTGRES_DB ?= postgres
PSQL ?= docker compose -f $(COMPOSE_FILE) exec -T postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

.PHONY: up down migrate seed

up:
	docker compose -f $(COMPOSE_FILE) up --build

down:
	docker compose -f $(COMPOSE_FILE) down

migrate:
	@for file in db/migrations/*.sql; do \
		echo "Applying $$file"; \
		$(PSQL) -v ON_ERROR_STOP=1 < "$$file"; \
	done

seed:
	$(PSQL) -v ON_ERROR_STOP=1 < db/seed.sql
