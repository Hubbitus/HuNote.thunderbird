.PHONY: help test test-e2e test-e2e-gui coverage pack verify-pack run run-fresh clean

SRC_DIR   := src
BUILD_DIR := build
DIST_DIR  := dist
VERSION   ?= $(shell date +%Y%m%d%H%M%S)
# semver X.Y.Z passes through unchanged; timestamps become 0.0.0.<ts> (TB-valid 4-segment).
XPI       := $(DIST_DIR)/hunote-$(VERSION).xpi

help:
	@echo "HuNote — Thunderbird extension (server-stored notes via IMAP headers)"
	@echo ""
	@echo "Targets:"
	@echo "  test          Run unit tests (vitest)"
	@echo "  test-e2e      Run unit + E2E (headless via xvfb)"
	@echo "  test-e2e-gui  Run unit + E2E with visible TB window"
	@echo "  coverage      Run tests with coverage report"
	@echo "  pack       Build $(XPI) from $(SRC_DIR)/"
	@echo "  verify-pack   Verify manifest.version inside built XPI matches VERSION"
	@echo "  run        Launch Thunderbird with disposable dev profile (reuse)"
	@echo "  run-fresh  Same as run but wipes .tmp/test-profile first"
	@echo "  clean      Remove $(BUILD_DIR)/, $(DIST_DIR)/ and coverage output"

test:
	./run.tests.sh

test-e2e:
	./run.tests.sh --e2e

test-e2e-gui:
	./run.tests.sh --e2e --with-gui

coverage:
	pnpm exec vitest run --coverage

pack:
	@rm -rf $(BUILD_DIR) $(XPI)
	@mkdir -p $(BUILD_DIR) $(DIST_DIR)
	@cp -r $(SRC_DIR)/. $(BUILD_DIR)/
	@jq --arg v "$(VERSION)" \
	    '.version = (if ($$v | test("^[0-9]+\\.[0-9]+\\.[0-9]+$$")) then $$v else "0.0.0." + $$v end)' \
	    $(SRC_DIR)/manifest.json > $(BUILD_DIR)/manifest.json
	@cd $(BUILD_DIR) && zip -qr ../$(XPI) . -x '*.DS_Store'
	@echo "Built $(XPI) (manifest.version=$$(jq -r .version $(BUILD_DIR)/manifest.json), size=$$(du -h $(XPI) | cut -f1))"

verify-pack:
	@test -f $(XPI) || (echo "no XPI at $(XPI); run 'make pack' first" && exit 1)
	@ACTUAL=$$(unzip -p $(XPI) manifest.json | jq -r .version); \
	 EXPECTED=$$(jq -r --arg v "$(VERSION)" \
	    '(if ($$v | test("^[0-9]+\\.[0-9]+\\.[0-9]+$$")) then $$v else "0.0.0." + $$v end)' \
	    <<<'{}'); \
	 test "$$ACTUAL" = "$$EXPECTED" || (echo "mismatch: manifest=$$ACTUAL expected=$$EXPECTED" && exit 1); \
	 echo "verify-pack ok ($$ACTUAL)"

# No lint target: web-ext lint = Firefox validator, always errors on TB experiment_apis.
# No Thunderbird-aware linter exists (checked 2026-08-20). ATN validates on upload.

run:
	./thunderbird-run.sh

run-fresh:
	./thunderbird-run.sh --fresh

clean:
	rm -rf $(BUILD_DIR) $(DIST_DIR) coverage
