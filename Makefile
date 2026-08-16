.PHONY: help test test-e2e test-e2e-gui coverage pack run run-fresh clean

XPI      := dist/hunote.xpi
SRC_DIR  := src
DIST_DIR := dist

help:
	@echo "HuNote — Thunderbird extension (server-stored notes via IMAP headers)"
	@echo ""
	@echo "Targets:"
	@echo "  test          Run unit tests (vitest)"
	@echo "  test-e2e      Run unit + E2E (headless via xvfb)"
	@echo "  test-e2e-gui  Run unit + E2E with visible TB window"
	@echo "  coverage      Run tests with coverage report"
	@echo "  pack       Build $(XPI) from $(SRC_DIR)/"
	@echo "  run        Launch Thunderbird with disposable dev profile (reuse)"
	@echo "  run-fresh  Same as run but wipes .tmp/test-profile first"
	@echo "  clean      Remove $(DIST_DIR)/ and coverage output"

test:
	./run.tests.sh

test-e2e:
	./run.tests.sh --e2e

test-e2e-gui:
	./run.tests.sh --e2e --with-gui

coverage:
	pnpm exec vitest run --coverage

pack: clean
	mkdir -p $(DIST_DIR)
	cd $(SRC_DIR) && zip -r ../$(XPI) . -x '*.DS_Store'
	@echo "Built $(XPI) ($$(du -h $(XPI) | cut -f1))"

run:
	./thunderbird-run.sh

run-fresh:
	./thunderbird-run.sh --fresh

clean:
	rm -rf $(DIST_DIR) coverage
