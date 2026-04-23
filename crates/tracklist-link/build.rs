// Tauri's build step — generates the asset manifest, Windows resource file,
// and the codegen'd allowlist/capabilities bindings. Must run before rustc
// compiles main.rs so the `tauri::generate_context!()` macro has the config
// available.
fn main() {
    tauri_build::build();
}
