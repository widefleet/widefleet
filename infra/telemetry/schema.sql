-- Widefleet telemetry schema v1. Collector schema: opentelemetry-collector-contrib v0.162.0.
-- Trace column layout: Copyright The OpenTelemetry Authors. SPDX-License-Identifier: Apache-2.0
CREATE DATABASE IF NOT EXISTS widefleet;

CREATE TABLE IF NOT EXISTS widefleet.otel_logs (
  Timestamp DateTime64(9), TraceId String, SpanId String, TraceFlags UInt8,
  SeverityText LowCardinality(String), SeverityNumber UInt8,
  ServiceName LowCardinality(String), Body String,
  ResourceSchemaUrl String, ResourceAttributes Map(LowCardinality(String), String),
  ScopeSchemaUrl String, ScopeName String, ScopeVersion String,
  ScopeAttributes Map(LowCardinality(String), String),
  LogAttributes Map(LowCardinality(String), String), EventName String,
  ReceivedAt DateTime64(6) DEFAULT now64(6), RecordId UUID DEFAULT generateUUIDv4(),
  INDEX trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1
) ENGINE = MergeTree
PARTITION BY toDate(ReceivedAt)
ORDER BY (ServiceName, ReceivedAt, RecordId)
TTL toDateTime(ReceivedAt) + INTERVAL 30 DAY DELETE;

CREATE TABLE IF NOT EXISTS widefleet.otel_traces (
    ReceivedAt DateTime64(6) DEFAULT now64(6),
    RecordId UUID DEFAULT generateUUIDv4(),
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),
    TraceId String CODEC(ZSTD(1)),
    SpanId String CODEC(ZSTD(1)),
    ParentSpanId String CODEC(ZSTD(1)),
    TraceState String CODEC(ZSTD(1)),
    SpanName LowCardinality(String) CODEC(ZSTD(1)),
    SpanKind LowCardinality(String) CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),
    SpanAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    Duration UInt64 CODEC(ZSTD(1)),
    StatusCode LowCardinality(String) CODEC(ZSTD(1)),
    StatusMessage String CODEC(ZSTD(1)),
    Events Nested (
        Timestamp DateTime64(9),
        Name LowCardinality(String),
        Attributes Map(LowCardinality(String), String)
    ) CODEC(ZSTD(1)),
    Links Nested (
        TraceId String,
        SpanId String,
        TraceState String,
        Attributes Map(LowCardinality(String), String)
    ) CODEC(ZSTD(1)),
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_res_attr_key mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_res_attr_value mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_key mapKeys(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_span_attr_value mapValues(SpanAttributes) TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_duration Duration TYPE minmax GRANULARITY 1
) ENGINE = MergeTree
PARTITION BY toDate(ReceivedAt)
ORDER BY (ServiceName, ReceivedAt, RecordId)
TTL toDateTime(ReceivedAt) + INTERVAL 30 DAY DELETE
SETTINGS index_granularity=8192, ttl_only_drop_parts = 1;

CREATE VIEW IF NOT EXISTS widefleet.runtime_logs AS
SELECT toString(RecordId) AS Id, Timestamp, ReceivedAt, ServiceName, TraceId, SpanId,
  SeverityNumber,
  if(JSONExtractUInt(Body, 'widefleet') = 1 AND JSONExtractString(Body, 'source') = 'browser', 'browser', 'server') AS Source,
  if(JSONExtractUInt(Body, 'widefleet') = 1 AND JSONExtractString(Body, 'kind') IN ('error', 'request'), JSONExtractString(Body, 'kind'), 'log') AS Kind,
  if(JSONExtractUInt(Body, 'widefleet') = 1, JSONExtractString(Body, 'message'), Body) AS Message,
  if(JSONExtractUInt(Body, 'widefleet') = 1, JSONExtractString(Body, 'stack'), '') AS Stack,
  if(JSONExtractUInt(Body, 'widefleet') = 1, JSONExtractString(Body, 'buildId'), '') AS BuildId,
  if(JSONExtractUInt(Body, 'widefleet') = 1, JSONExtractString(Body, 'deploymentId'), '') AS DeploymentId,
  if(JSONExtractUInt(Body, 'widefleet') = 1, JSONExtractString(Body, 'requestId'), '') AS RequestId,
  if(JSONExtractUInt(Body, 'widefleet') = 1, JSONExtractString(Body, 'route'), '') AS Route,
  if(JSONExtractUInt(Body, 'widefleet') = 1, JSONExtractUInt(Body, 'status'), 0) AS Status,
  Body
FROM widefleet.otel_logs
UNION ALL
SELECT toString(RecordId), Timestamp, ReceivedAt, ServiceName, TraceId, SpanId,
  toUInt8(17), 'runtime', 'span_error', StatusMessage, StatusMessage,
  '', '', SpanAttributes['celld.request_id'], '', toUInt64(0), StatusMessage
FROM widefleet.otel_traces WHERE StatusCode = 'Error';
