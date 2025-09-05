FROM library/golang:1.23.10-alpine AS builder
WORKDIR /app
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o o2o .

FROM alpine:3.20
COPY --from=builder /app/o2o .
COPY ./web /web
ENTRYPOINT ["./o2o"]