# Local dev server control. `pnpm dev` runs in the background; output goes to $(LOG).
#   make start | stop | restart | status | logs

SHELL := /bin/bash
PID   := .dev.pid
LOG   := .dev.log
# same default as apps/api/src/index.ts; .env overrides
PORT  := $(or $(shell grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '"'),3001)
URL   := http://localhost:$(PORT)

# kill a pid and all its descendants (pnpm -> pnpm -> tsx watch -> node)
define KILL_TREE
kill_tree() { for c in $$(pgrep -P $$1); do kill_tree $$c; done; kill $$1 2>/dev/null || true; }
endef

.PHONY: start stop restart status logs

# one shell for the whole recipe, so the "already running" exit really stops it
start:
	@if [ -f $(PID) ] && kill -0 $$(cat $(PID)) 2>/dev/null; then \
		echo "already running (pid $$(cat $(PID))) on $(URL)"; exit 0; fi; \
	nohup pnpm dev > $(LOG) 2>&1 & echo $$! > $(PID); \
	echo "starting (pid $$(cat $(PID))), log: $(LOG)"; \
	for i in $$(seq 1 60); do \
		if curl -sf -m 2 $(URL)/api/health >/dev/null; then echo "up on $(URL)"; exit 0; fi; \
		if ! kill -0 $$(cat $(PID)) 2>/dev/null; then echo "exited, last log lines:"; tail -20 $(LOG); rm -f $(PID); exit 1; fi; \
		sleep 1; \
	done; echo "not healthy after 60s, check: make logs"; exit 1

stop:
	@$(KILL_TREE); \
	if [ -f $(PID) ]; then kill_tree $$(cat $(PID)); rm -f $(PID); fi; \
	pkill -f "$(CURDIR)/.*tsx" 2>/dev/null || true; \
	for i in $$(seq 1 10); do lsof -ti tcp:$(PORT) -sTCP:LISTEN >/dev/null || break; sleep 0.5; done; \
	if lsof -ti tcp:$(PORT) -sTCP:LISTEN >/dev/null; then echo "port $(PORT) still in use:"; lsof -i tcp:$(PORT) -sTCP:LISTEN; exit 1; fi; \
	echo "stopped"

restart: stop start

status:
	@if [ -f $(PID) ] && kill -0 $$(cat $(PID)) 2>/dev/null; then echo "running (pid $$(cat $(PID)))"; else echo "not running"; fi
	@curl -sf -m 2 $(URL)/api/health && echo " $(URL)" || echo "no response on $(URL)"

logs:
	@tail -f $(LOG)
