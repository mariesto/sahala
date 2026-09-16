# sahala — build & ship shortcuts
# Usage: make <target>   (run `make` alone to list targets)

APP     := /Applications/Sahala.app
BUNDLE  := src-tauri/target/release/bundle/macos/Sahala.app
DMG_DIR := src-tauri/target/release/bundle/dmg

.PHONY: help dev build install run ship check icons clean

help: ## List available targets
	@grep -E '^[a-z]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

dev: ## Run the app in dev mode (hot reload)
	npm run tauri dev

build: ## Build release bundle (sahala.app + .dmg)
	npm run tauri build

install: ## Replace /Applications/sahala.app with the fresh build (quits it first)
	-osascript -e 'tell application "Sahala" to quit' 2>/dev/null
	rm -rf $(APP)
	cp -R $(BUNDLE) $(APP)

run: ## Launch the installed app
	open $(APP)

ship: build install run ## Build + install + launch, in one go

check: ## Type-check the frontend and the Rust backend
	npx tsc --noEmit
	cd src-tauri && cargo check

icons: ## Regenerate the full icon set from assets/icon/*.svg
	# master + Tauri-generated set (png/ico/icns baseline)
	rsvg-convert -w 1024 -h 1024 assets/icon/seal.svg -o assets/icon-source.png
	npm run tauri icon assets/icon-source.png
	# custom icns: simplified art at <=32px optical sizes (per icon spec 6a)
	rm -rf assets/icon/sahala.iconset && mkdir assets/icon/sahala.iconset
	rsvg-convert -w 16 -h 16 assets/icon/seal-simple.svg -o assets/icon/sahala.iconset/icon_16x16.png
	rsvg-convert -w 32 -h 32 assets/icon/seal-simple.svg -o assets/icon/sahala.iconset/icon_16x16@2x.png
	rsvg-convert -w 32 -h 32 assets/icon/seal-simple.svg -o assets/icon/sahala.iconset/icon_32x32.png
	rsvg-convert -w 64 -h 64 assets/icon/seal-simple.svg -o assets/icon/sahala.iconset/icon_32x32@2x.png
	for s in 128 256 512; do \
	  rsvg-convert -w $$s -h $$s assets/icon/seal.svg -o assets/icon/sahala.iconset/icon_$${s}x$${s}.png; \
	  rsvg-convert -w $$(($$s*2)) -h $$(($$s*2)) assets/icon/seal.svg -o assets/icon/sahala.iconset/icon_$${s}x$${s}@2x.png; \
	done
	iconutil -c icns assets/icon/sahala.iconset -o src-tauri/icons/icon.icns
	rm -rf assets/icon/sahala.iconset
	# dock-switchable alternates + picker previews
	for v in seal band fringe word; do \
	  rsvg-convert -w 1024 -h 1024 assets/icon/$$v.svg -o src-tauri/icons/alt/$$v.png; \
	  magick src-tauri/icons/alt/$$v.png -resize 256x256 public/app-icons/$$v.png; \
	done

clean: ## Remove build artifacts (frontend dist + Rust target)
	rm -rf dist src-tauri/target
