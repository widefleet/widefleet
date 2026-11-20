// The shadow stack is the first region of linear memory. tsrs ships 80 MiB for
// pathological expressions; SERVICE_DOCS_WASM_STACK_SIZE (bytes) overrides the
// default for measurements.
const STACK_SIZE: u64 = 8 << 20;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=SERVICE_DOCS_WASM_STACK_SIZE");
    let family = std::env::var("CARGO_CFG_TARGET_FAMILY").unwrap_or_default();
    if family.split(',').any(|f| f == "wasm") {
        let size = std::env::var("SERVICE_DOCS_WASM_STACK_SIZE")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(STACK_SIZE);
        println!("cargo:rustc-cdylib-link-arg=-zstack-size={size}");
    }
}
