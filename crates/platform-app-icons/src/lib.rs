//! PNG app icons for home screens and installed apps, rendered from an app's
//! `/favicon.svg` when it ships no PNG icon of its own.

use resvg::{tiny_skia, usvg};

/// The SVG an app ships as its icon.
pub const SOURCE: &str = "/favicon.svg";

/// Largest SVG rendered, as for the icons the control plane shows.
pub const MAX_SVG_BYTES: usize = 256 * 1024;

/// Generated icons with their size and whether they are opaque: iOS requests the
/// first at the site root and shows transparency as black, so it gets a white
/// background. Web app manifests list all.
pub const ICONS: [(&str, u32, bool); 3] = [
    ("/apple-touch-icon.png", 180, true),
    ("/icon-192.png", 192, false),
    ("/icon-512.png", 512, false),
];

/// PNG icons an app ships itself; any of them leaves its icons as they are.
const OWN: [&str; 4] = [
    "/apple-touch-icon.png",
    "/favicon.png",
    "/icon-192.png",
    "/icon-512.png",
];

/// Whether an app with these asset paths gets generated icons.
pub fn wanted(has: impl Fn(&str) -> bool) -> bool {
    has(SOURCE) && !OWN.iter().any(|path| has(path))
}

#[derive(Debug)]
pub struct Error(String);

impl std::fmt::Display for Error {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

/// Renders the SVG centered on a square of `size` pixels, white when `opaque`.
pub fn render(svg: &[u8], size: u32, opaque: bool) -> Result<Vec<u8>, Error> {
    if svg.len() > MAX_SVG_BYTES {
        return Err(Error(format!("{SOURCE} exceeds 256 KiB")));
    }
    // References to other files and images are never resolved.
    let options = usvg::Options {
        resources_dir: None,
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..usvg::Options::default()
    };
    let tree = usvg::Tree::from_data(svg, &options)
        .map_err(|error| Error(format!("{SOURCE} is not a valid SVG: {error}")))?;
    let mut pixmap = tiny_skia::Pixmap::new(size, size)
        .ok_or_else(|| Error("Icon size must be positive".into()))?;
    if opaque {
        pixmap.fill(tiny_skia::Color::WHITE);
    }
    let side = size as f32;
    let bounds = tree.size();
    let scale = (side / bounds.width()).min(side / bounds.height());
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale).post_translate(
            (side - bounds.width() * scale) / 2.0,
            (side - bounds.height() * scale) / 2.0,
        ),
        &mut pixmap.as_mut(),
    );
    pixmap
        .encode_png()
        .map_err(|error| Error(format!("Icon could not be encoded: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><rect width="32" height="16" fill="#5b5bd6"/></svg>"##;

    fn dimensions(png: &[u8]) -> (u32, u32) {
        let number = |offset: usize| {
            png.get(offset..offset + 4)
                .and_then(|bytes| bytes.try_into().ok())
                .map_or(0, u32::from_be_bytes)
        };
        (number(16), number(20))
    }

    #[test]
    fn renders_square_icons_with_the_svg_centered() -> Result<(), Error> {
        for (_, size, opaque) in ICONS {
            assert_eq!(dimensions(&render(LOGO, size, opaque)?), (size, size));
        }
        let corner = |opaque| -> Result<_, Error> {
            let pixmap = tiny_skia::Pixmap::decode_png(&render(LOGO, 32, opaque)?)
                .map_err(|error| Error(error.to_string()))?;
            // A 2:1 logo fills the middle half.
            assert_eq!(pixmap.pixel(16, 16).map(|pixel| pixel.alpha()), Some(255));
            Ok(pixmap
                .pixel(16, 2)
                .map(|pixel| (pixel.red(), pixel.alpha())))
        };
        assert_eq!(corner(false)?, Some((0, 0)));
        assert_eq!(corner(true)?, Some((255, 255)));
        Ok(())
    }

    #[test]
    fn rejects_oversized_and_invalid_svgs() {
        assert!(render(&vec![b' '; MAX_SVG_BYTES + 1], 180, true).is_err());
        assert!(render(b"<html></html>", 180, true).is_err());
    }

    #[test]
    fn apps_with_png_icons_keep_them() {
        let only = |paths: &'static [&'static str]| move |path: &str| paths.contains(&path);
        assert!(wanted(only(&["/favicon.svg"])));
        assert!(!wanted(only(&["/favicon.svg", "/favicon.png"])));
        assert!(!wanted(only(&["/favicon.svg", "/apple-touch-icon.png"])));
        assert!(!wanted(only(&["/favicon.png"])));
    }
}
