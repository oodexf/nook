.PHONY: build check check-backend check-frontend test frontend-install frontend-build docker-build docker-dev

frontend-install:
	npm --prefix frontend ci

frontend-build:
	npm --prefix frontend run build

check: check-frontend check-backend

check-frontend:
	npm --prefix frontend run check
	npm --prefix frontend run lint

check-backend:
	cargo fmt --check
	cargo clippy --workspace --all-targets -- -D warnings

test:
	npm --prefix frontend run test
	cargo test --workspace

build: frontend-build
	cargo build --workspace --release

# The Dockerfile only builds artifacts; the quality gate runs here so a local
# image build keeps the same coverage the release workflow enforces in CI.
docker-build: check test
	docker build -t nook:local .

docker-dev: docker-build
	docker compose -f compose.yaml -f compose.dev.yaml up -d
