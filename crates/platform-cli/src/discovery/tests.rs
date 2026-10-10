use super::*;
use std::{net::TcpListener, thread::JoinHandle};

fn txt(parts: &[&str]) -> Vec<u8> {
    parts
        .iter()
        .flat_map(|part| std::iter::once(part.len() as u8).chain(part.bytes()))
        .collect()
}

#[test]
fn normalizes_domains_and_discards_email_local_parts() -> Result<()> {
    let domain = Domain::from_email("  employee+team@EXAMPLE.COM  ")?;
    assert_eq!(domain, Domain::parse("example.com.")?);
    assert_eq!(domain.record_name(), "_widefleet.example.com.");
    assert_eq!(
        domain.endpoint(),
        "https://example.com/.well-known/widefleet"
    );
    assert_eq!(Domain::parse("bücher.example")?.0, "xn--bcher-kva.example");
    for input in [
        "@example.com",
        "employee@@example.com",
        "employee @example.com",
        "employee",
        "employee@example.com/path",
    ] {
        assert!(Domain::from_email(input).is_err(), "{input}");
    }
    Ok(())
}

#[test]
fn rejects_urls_ip_addresses_and_domain_delimiters() {
    for input in [
        "",
        "localhost",
        "127.0.0.1",
        "[::1]",
        "https://example.com",
        "example.com:443",
        "example.com/path",
        "example.com?query",
        "example.com#fragment",
        "user@example.com",
        "example.com\\other",
        "example%2ecom",
        "example..com",
        "-example.com",
        "example-.com",
        "example_com.test",
        "example.com..",
        "example.com\nother.test",
    ] {
        assert!(Domain::parse(input).is_err(), "{input}");
    }
    assert!(Domain::parse(&format!("{}.com", "a".repeat(64))).is_err());
    assert!(
        Domain::parse(&format!(
            "{}.{}.{}.com",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63)
        ))
        .is_ok()
    );
    assert!(
        Domain::parse(&format!(
            "{}.{}.{}.{}",
            "a".repeat(63),
            "b".repeat(63),
            "c".repeat(63),
            "d".repeat(63)
        ))
        .is_err()
    );
}

#[test]
fn combines_txt_chunks_and_accepts_only_one_distinct_https_origin() -> Result<()> {
    assert_eq!(from_txt(&[])?, None);
    let record = txt(&["url=https://", "platform.example.com"]);
    assert_eq!(
        from_txt(&[
            record.clone(),
            txt(&["url=https://platform.example.com:443/"])
        ])?,
        Some("https://platform.example.com".into())
    );
    assert!(from_txt(&[record, txt(&["url=https://other.example.com"])]).is_err());
    for record in [
        Vec::new(),
        vec![4, b'u'],
        vec![1, 255],
        txt(&["https://platform.example.com"]),
        txt(&["url=http://localhost"]),
        txt(&["url=https://user:secret@example.com"]),
        txt(&["url=https://example.com/path"]),
        txt(&["url=https://example.com?secret=1"]),
        txt(&["url=https://example.com#fragment"]),
        txt(&["url=https://exam\tple.com"]),
    ] {
        assert!(from_txt(&[record]).is_err());
    }
    Ok(())
}

#[tokio::test]
async fn valid_dns_avoids_https_and_invalid_dns_does_not_fall_back() -> Result<()> {
    let domain = Domain::parse("example.test")?;
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(1))
        .build()?;
    let records = DnsLookup::Records(vec![txt(&["url=https://platform.example.test"])]);
    assert_eq!(
        resolve_with(&domain, records, &client).await?,
        "https://platform.example.test"
    );
    let invalid = DnsLookup::Records(vec![txt(&["url=http://platform.example.test"])]);
    let error = resolve_with(&domain, invalid, &client)
        .await
        .err()
        .ok_or_else(|| Error::invalid("Expected discovery failure".into()))?;
    assert!(error.to_string().contains("Discovery must specify"));
    Ok(())
}

fn serve(response: String) -> Result<(String, JoinHandle<std::io::Result<String>>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let endpoint = format!("http://{}/.well-known/widefleet", listener.local_addr()?);
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept()?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") && request.len() < 8192 {
            let mut byte = [0];
            stream.read_exact(&mut byte)?;
            request.push(byte[0]);
        }
        stream.write_all(response.as_bytes())?;
        Ok(String::from_utf8_lossy(&request).into_owned())
    });
    Ok((endpoint, thread))
}

fn join_request(thread: JoinHandle<std::io::Result<String>>) -> Result<String> {
    Ok(thread
        .join()
        .map_err(|_| Error::invalid("HTTP fixture panicked".into()))??)
}

#[tokio::test]
async fn reads_https_document_shape_without_credentials_and_checks_body_limits() -> Result<()> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    let body = r#"{"platform_url":"https://platform.example.test"}"#;
    let (endpoint, thread) = serve(format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    ))?;
    assert_eq!(
        from_https(&client, &endpoint).await?,
        "https://platform.example.test"
    );
    let request = join_request(thread)?;
    assert!(request.starts_with("GET /.well-known/widefleet HTTP/1.1\r\n"));
    assert!(!request.contains("authorization"));
    assert!(!request.contains("cookie"));

    for body in [
        "{}",
        r#"{"platform_url":"http://localhost"}"#,
        r#"{"platform_url":"https://example.test", "typo":true}"#,
        r#"{"platform_url":"https://a.test", "platform_url":"https://b.test"}"#,
        "<html>Sign in</html>",
    ] {
        let (endpoint, thread) = serve(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ))?;
        assert!(from_https(&client, &endpoint).await.is_err());
        join_request(thread)?;
    }
    // Check limits with and without a declared Content-Length.
    for headers in ["Content-Length: 8193\r\n", "Connection: close\r\n"] {
        let (endpoint, thread) = serve(format!(
            "HTTP/1.1 200 OK\r\n{headers}\r\n{}",
            "x".repeat(8193)
        ))?;
        let result = from_https(&client, &endpoint).await;
        assert!(result.is_err_and(|error| error.to_string().contains("exceeds 8 KiB")));
        join_request(thread)?;
    }
    Ok(())
}

#[tokio::test]
async fn rejects_redirects_and_http_errors() -> Result<()> {
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    for status in ["302 Found", "404 Not Found", "503 Service Unavailable"] {
        let (endpoint, thread) = serve(format!(
            "HTTP/1.1 {status}\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\n\r\n"
        ))?;
        assert!(
            from_https(&client, &endpoint)
                .await
                .is_err_and(|error| error.to_string().contains(status))
        );
        join_request(thread)?;
    }
    Ok(())
}
