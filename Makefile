.PHONY: build check check-backend check-frontend test frontend-install frontend-build docker-build

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

docker-build:
	docker build -t minimal-ai-chat:local .
