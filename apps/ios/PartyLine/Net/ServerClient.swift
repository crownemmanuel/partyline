import Foundation

struct ServerAddress: Codable, Equatable, Hashable {
    var host: String
    var port: Int

    var baseURL: URL? {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.port = port
        return c.url
    }

    var display: String { port == 8443 ? host : "\(host):\(port)" }

    /// Accepts "10.0.0.5", "10.0.0.5:8443", "https://partyline.local:8443/..." and join links.
    static func parse(_ text: String) -> ServerAddress? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        if let link = Wire.parseJoinLink(t.contains("://") ? t : "https://\(t)") {
            return ServerAddress(host: link.host, port: link.port)
        }
        return nil
    }
}

enum ServerClientError: LocalizedError, Equatable {
    case api(code: String, message: String?, status: Int, retryAfter: Int?)
    case pinMismatch
    case badResponse
    case transport(String)

    var errorDescription: String? {
        switch self {
        case let .api(code, message, _, retryAfter):
            switch code {
            case "invalid_code": return "Wrong join code."
            case "join_closed": return "Joining is closed on the host."
            case "rate_limited": return "Too many attempts. Try again in \(retryAfter ?? 300) s."
            case "revoked": return "This phone was removed by the admin. Join again with a code."
            case "invalid_token": return "Saved login is no longer valid. Join again with a code."
            case "version_unsupported": return "This app version is not supported by the host. Update PartyLine."
            default: return message ?? code
            }
        case .pinMismatch: return "The server's certificate changed. Refusing to connect."
        case .badResponse: return "Unexpected response from the server."
        case let .transport(s): return s
        }
    }

    var code: String? { if case let .api(code, _, _, _) = self { return code }; return nil }
}

/// REST client for /api/info, /api/join, /api/session, /api/messages with cert pinning.
final class ServerClient {
    let address: ServerAddress
    let delegate: PinningDelegate
    private let session: URLSession

    init(address: ServerAddress, pin: String?) {
        self.address = address
        delegate = PinningDelegate(pin: pin)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.waitsForConnectivity = false
        config.networkServiceType = .responsiveData
        session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    /// Probe without a pin (TOFU). Returns the info and the cert fingerprint actually seen.
    func probe() async throws -> (InfoResponse, observedFingerprint: String) {
        let info: InfoResponse = try await request("GET", "/api/info")
        guard let fp = delegate.observedFingerprint else { throw ServerClientError.badResponse }
        return (info, fp)
    }

    func info() async throws -> InfoResponse { try await request("GET", "/api/info") }

    func join(_ body: JoinRequest) async throws -> SessionResponse { try await request("POST", "/api/join", body: body) }

    func session(deviceToken: String) async throws -> SessionResponse {
        try await request("POST", "/api/session", body: SessionRequest(), token: deviceToken)
    }

    func messages(deviceToken: String, since: String?) async throws -> [Message] {
        var path = "/api/messages?limit=100"
        if let since, let q = since.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { path += "&since=\(q)" }
        return try await request("GET", path, token: deviceToken)
    }

    /// The session this client uses, so the control socket shares the same pin.
    var urlSession: URLSession { session }

    private func request<T: Decodable>(_ method: String, _ path: String, token: String? = nil) async throws -> T {
        try await request(method, path, bodyData: nil, token: token)
    }

    private func request<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B, token: String? = nil) async throws -> T {
        try await request(method, path, bodyData: try JSONEncoder().encode(body), token: token)
    }

    private func request<T: Decodable>(_ method: String, _ path: String, bodyData: Data?, token: String?) async throws -> T {
        guard let base = address.baseURL, let url = URL(string: path, relativeTo: base) else { throw ServerClientError.badResponse }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bodyData {
            req.httpBody = bodyData
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let e as URLError where e.code == .cancelled || e.code == .serverCertificateUntrusted
            || e.code == .secureConnectionFailed {
            if delegate.pin != nil, let seen = delegate.observedFingerprint, seen != delegate.pin { throw ServerClientError.pinMismatch }
            throw ServerClientError.transport(e.localizedDescription)
        } catch {
            throw ServerClientError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw ServerClientError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            let retry = (http.value(forHTTPHeaderField: "Retry-After")).flatMap(Int.init)
            throw ServerClientError.api(code: body?.error.code ?? "http_\(http.statusCode)", message: body?.error.message,
                                        status: http.statusCode, retryAfter: retry)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ServerClientError.transport("Could not read server response: \(error)")
        }
    }
}
