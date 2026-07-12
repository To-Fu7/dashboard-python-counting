FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/stream-gateway .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/stream-gateway /usr/local/bin/stream-gateway
ENTRYPOINT ["/usr/local/bin/stream-gateway"]
