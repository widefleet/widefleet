// ABI (one request per module instance), as tsrs_wasm:
//   tsrs_input(len) -> ptr    a buffer of `len` bytes for the request
//   tsrs_run() -> status      0 documented, 1 failed (message on stderr), 5 panicked
//   tsrs_output() -> ptr      the documentation JSON
//   tsrs_output_len() -> len
// Request: NUL-separated UTF-8 `cwd \0 flags \0 project \0 bundle \0 map \0 entry \0 entrypoint...`.
// flags is decimal; 2 marks a case-insensitive host file system. `bundle`, `map`
// and `entry` are paths on the host file system; `-` as entry selects the bundle
// mode of `platform_service_docs::extract`.
#![cfg(target_family = "wasm")]

mod host;

use std::cell::RefCell;

const REQUEST_CASE_INSENSITIVE: u32 = 2;

fn run(request: &[u8]) -> (i32, Vec<u8>) {
    // The one-thread rayon pool must exist before any other rayon use.
    tsrs_compiler::worker_pool();
    let mut fields = request
        .split(|&b| b == 0)
        .map(|f| String::from_utf8_lossy(f).into_owned());
    let _cwd = fields.next().unwrap_or_default();
    let flags = fields
        .next()
        .and_then(|f| f.parse::<u32>().ok())
        .unwrap_or(0);
    let project = fields.next().unwrap_or_default();
    let bundle = fields.next().unwrap_or_default();
    let map_path = fields.next().unwrap_or_default();
    let entry = fields.next().filter(|entry| entry != "-");
    let entrypoints: Vec<String> = fields.collect();
    let fs: &'static host::HostFs = Box::leak(Box::new(host::HostFs::new(
        flags & REQUEST_CASE_INSENSITIVE == 0,
    )));
    let Some(map) = tsrs_vfs::FS::read_file(fs, &map_path) else {
        eprintln!("Cannot read source map {map_path}");
        return (1, Vec::new());
    };
    match platform_service_docs::extract(
        fs,
        &project,
        &bundle,
        &map,
        entry.as_deref(),
        &entrypoints,
    ) {
        Ok(value) => (0, value.to_string().into_bytes()),
        Err(error) => {
            eprintln!("{error}");
            (1, Vec::new())
        }
    }
}

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn tsrs_input(len: usize) -> *mut u8 {
    INPUT.with_borrow_mut(|input| {
        input.clear();
        input.resize(len, 0);
        input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn tsrs_run() -> i32 {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        std::process::exit(5);
    }));
    let request = INPUT.with_borrow_mut(std::mem::take);
    let (status, reply) = run(&request);
    OUTPUT.with_borrow_mut(|output| *output = reply);
    status
}

#[unsafe(no_mangle)]
pub extern "C" fn tsrs_output() -> *const u8 {
    OUTPUT.with_borrow(Vec::as_ptr)
}

#[unsafe(no_mangle)]
pub extern "C" fn tsrs_output_len() -> usize {
    OUTPUT.with_borrow(Vec::len)
}
