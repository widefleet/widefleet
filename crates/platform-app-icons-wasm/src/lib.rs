// ABI (one request per module instance):
//   icons_input(len) -> ptr   a buffer of `len` bytes for the SVG
//   icons_run(size, opaque) -> status 0 rendered, 1 failed (message as output)
//   icons_output() -> ptr     the PNG, or the failure message
//   icons_output_len() -> len
#![cfg(target_family = "wasm")]

use std::cell::RefCell;

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn icons_input(len: usize) -> *mut u8 {
    INPUT.with_borrow_mut(|input| {
        input.clear();
        input.resize(len, 0);
        input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn icons_run(size: u32, opaque: u32) -> i32 {
    let (status, reply) =
        INPUT.with_borrow(
            |svg| match platform_app_icons::render(svg, size, opaque != 0) {
                Ok(png) => (0, png),
                Err(error) => (1, error.to_string().into_bytes()),
            },
        );
    OUTPUT.with_borrow_mut(|output| *output = reply);
    status
}

#[unsafe(no_mangle)]
pub extern "C" fn icons_output() -> *const u8 {
    OUTPUT.with_borrow(Vec::as_ptr)
}

#[unsafe(no_mangle)]
pub extern "C" fn icons_output_len() -> usize {
    OUTPUT.with_borrow(Vec::len)
}
