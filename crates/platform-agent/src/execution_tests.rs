use super::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    thread,
};

fn request(listener: &TcpListener) -> std::io::Result<(TcpStream, String)> {
    let (mut stream, _) = listener.accept()?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut reader = BufReader::new(&mut stream);
    let mut start = String::new();
    reader.read_line(&mut start)?;
    let mut length = 0;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" {
            break;
        }
        if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().map_err(std::io::Error::other)?;
        }
    }
    reader.read_exact(&mut vec![0; length])?;
    Ok((stream, start))
}

fn respond(stream: &mut TcpStream, body: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn docker_exec(
    exit: i64,
    gate: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
) -> Result<(Docker, thread::JoinHandle<std::io::Result<()>>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let docker = Docker::connect_with_http(
        &format!("http://{}", listener.local_addr()?),
        5,
        bollard::API_DEFAULT_VERSION,
    )
    .map_err(|error| Error::invalid(error.to_string()))?;
    let server = thread::spawn(move || {
        let (mut stream, path) = request(&listener)?;
        assert!(path.contains("/containers/platform-fleet-"));
        respond(&mut stream, r#"{"Id":"fixture-exec"}"#)?;
        drop(stream);

        let (mut stream, path) = request(&listener)?;
        assert!(path.contains("/exec/fixture-exec/start"));
        write!(
            stream,
            "HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
        )?;
        if let Some((started, finish)) = gate {
            started.send(()).map_err(std::io::Error::other)?;
            finish
                .recv_timeout(Duration::from_secs(5))
                .map_err(std::io::Error::other)?;
        }
        for (kind, content) in [
            (1, r#"{"message":"precise operator result"}"#),
            (2, "curl: request status diagnostic"),
        ] {
            stream.write_all(&[kind, 0, 0, 0])?;
            stream.write_all(&(content.len() as u32).to_be_bytes())?;
            stream.write_all(content.as_bytes())?;
        }
        drop(stream);

        let (mut stream, path) = request(&listener)?;
        assert!(path.contains("/exec/fixture-exec/json"));
        respond(
            &mut stream,
            &value!({ "Running": false, "ExitCode": exit }).to_string(),
        )
    });
    Ok((docker, server))
}

fn job() -> Result<Job> {
    Ok(serde_json::from_value(value!({
        "fleetId": uuid::Uuid::new_v4(), "id": uuid::Uuid::new_v4(),
        "kind": "migrations", "attempt": 1, "leaseToken": uuid::Uuid::new_v4(),
        "leaseUntil": "2099-01-01T00:00:00Z"
    }))?)
}

#[tokio::test]
async fn failed_heartbeat_waits_for_the_running_docker_command() -> Result<()> {
    let (started_tx, started_rx) = mpsc::channel();
    let (finish_tx, finish_rx) = mpsc::channel();
    let (docker, docker_server) = docker_exec(0, Some((started_tx, finish_rx)))?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let api = Api::new(&format!("http://{}", listener.local_addr()?))?;
    let heartbeat_server = thread::spawn(move || -> std::io::Result<()> {
        let (mut stream, path) = request(&listener)?;
        assert!(path.contains("/heartbeat"));
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(std::io::Error::other)?;
        write!(
            stream,
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    });
    let job = job()?;
    let cancelled = AtomicBool::new(false);
    let finished = AtomicBool::new(false);
    let operation = async {
        docker::execute_output(&docker, &job, vec!["fixture".into()]).await?;
        finished.store(true, Ordering::Relaxed);
        Ok(None)
    };
    let supervised = leased_execute(&api, "synthetic-agent-token", &job, &cancelled, operation);
    tokio::pin!(supervised);
    tokio::select! {
        result = &mut supervised => panic!("Job completed before its Docker command: {result:?}"),
        _ = async {
            while !cancelled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        } => {},
        _ = tokio::time::sleep(Duration::from_secs(5)) => panic!("Heartbeat fixture did not fail"),
    }
    assert!(!finished.load(Ordering::Relaxed));
    finish_tx
        .send(())
        .map_err(|error| Error::invalid(error.to_string()))?;
    let result = supervised.await;
    assert!(
        matches!(result, Err(error) if matches!(error.kind(), platform_core::ErrorKind::Api { status: 503, .. }))
    );
    assert!(finished.load(Ordering::Relaxed));
    heartbeat_server
        .join()
        .map_err(|_| Error::invalid("Heartbeat fixture panicked".into()))??;
    docker_server
        .join()
        .map_err(|_| Error::invalid("Docker fixture panicked".into()))??;
    Ok(())
}

#[tokio::test]
async fn docker_failures_preserve_both_streams_and_success_keeps_only_stdout() -> Result<()> {
    for exit in [0, 22] {
        let (docker, server) = docker_exec(exit, None)?;
        let result = docker::execute_output(&docker, &job()?, vec!["fixture".into()]).await;
        if exit == 0 {
            assert_eq!(result?, br#"{"message":"precise operator result"}"#);
        } else {
            let Err(error) = result else {
                panic!("Failed command was accepted")
            };
            assert!(error.to_string().contains("precise operator result"));
            assert!(
                error
                    .to_string()
                    .contains("curl: request status diagnostic")
            );
        }
        server
            .join()
            .map_err(|_| Error::invalid("Docker fixture panicked".into()))??;
    }
    Ok(())
}
