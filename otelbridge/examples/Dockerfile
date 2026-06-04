# Demo application image.
#
# IMPORTANT: the build context must be the repository ROOT, because the
# otelbridge module uses `replace github.com/surpradhan/aep-go => ../sdks/go`,
# which lives outside otelbridge/. docker-compose.yml sets `context: ..`.
#
#   docker build -f otelbridge/examples/Dockerfile -t aep-demo-app .
#
FROM golang:1.21-alpine AS builder

WORKDIR /build
# Bring in both the local SDK (replace target) and the otelbridge module.
COPY sdks/go/ ./sdks/go/
COPY otelbridge/ ./otelbridge/

WORKDIR /build/otelbridge
RUN go mod tidy && go build -o /demo-app ./examples/

# Runtime stage
FROM alpine:latest
COPY --from=builder /demo-app /app/demo-app
ENTRYPOINT ["/app/demo-app"]
