/**
 * Minimal obs-websocket v5 client — just enough to create a Browser
 * Source for the Tracklist visualizer. Hand-rolled over the native
 * WebSocket API (Tauri's webview is Chromium) to avoid pulling a 30 KB
 * third-party client for two RPCs.
 *
 * Protocol reference:
 *   https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 *
 * Auth flow (server with password):
 *   1. Server sends Hello (op 0) with {obsWebSocketVersion, rpcVersion,
 *      authentication: {challenge, salt}}.
 *   2. We compute:
 *        secret = base64(sha256(password + salt))
 *        auth   = base64(sha256(secret   + challenge))
 *   3. We send Identify (op 1) with {rpcVersion: 1, authentication,
 *      eventSubscriptions: 0}.
 *   4. Server sends Identified (op 2). We're in.
 *   5. We send Request (op 6) with {requestType, requestId,
 *      requestData}.
 *   6. Server sends RequestResponse (op 7) with matching requestId.
 *
 * Timeouts / errors surface as Error instances with actionable messages
 * so the UI can map them to user-friendly hints ("is OBS running?",
 * "password wrong", etc.).
 */

interface HelloPayload {
  obsWebSocketVersion: string;
  rpcVersion: number;
  authentication?: { challenge: string; salt: string };
}

interface RequestStatus {
  result: boolean;
  code: number;
  comment?: string;
}

interface RequestResponsePayload {
  requestType: string;
  requestId: string;
  requestStatus: RequestStatus;
  responseData?: Record<string, unknown>;
}

async function sha256Base64(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = new Uint8Array(hash);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin);
}

async function computeAuth(
  password: string,
  salt: string,
  challenge: string,
): Promise<string> {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

export class ObsClient {
  private ws: WebSocket | null = null;
  private identified = false;
  private pending = new Map<
    string,
    {
      resolve: (data: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }
  >();

  /**
   * Connect + authenticate. Throws on timeout, wrong password, network
   * error. `url` defaults to ws://127.0.0.1:4455 which is the OBS default.
   */
  async connect(
    url: string,
    password?: string,
    timeoutMs = 5000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          this.ws?.close();
        } catch {
          // already gone
        }
        reject(
          new Error(
            "Couldn't reach OBS WebSocket. Check that OBS is running + Tools → WebSocket Server Settings has 'Enable WebSocket server' ticked.",
          ),
        );
      }, timeoutMs);

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        window.clearTimeout(timer);
        reject(new Error((err as Error).message));
        return;
      }
      this.ws = ws;

      ws.addEventListener("open", () => {
        // Nothing — server speaks first with Hello.
      });

      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(
          new Error(
            "WebSocket connection error. Usually OBS isn't running or the port is blocked.",
          ),
        );
      });

      ws.addEventListener("close", (evt) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        const reason = evt.reason || `closed with code ${evt.code}`;
        reject(new Error(`OBS disconnected before auth: ${reason}`));
      });

      ws.addEventListener("message", async (msg) => {
        let parsed: { op: number; d: unknown };
        try {
          parsed = JSON.parse(String(msg.data));
        } catch {
          return;
        }
        if (parsed.op === 0) {
          const hello = parsed.d as HelloPayload;
          const payload: Record<string, unknown> = {
            rpcVersion: hello.rpcVersion ?? 1,
            eventSubscriptions: 0,
          };
          if (hello.authentication) {
            if (!password) {
              if (settled) return;
              settled = true;
              window.clearTimeout(timer);
              reject(
                new Error(
                  "OBS requires a password but none was provided. Check Tools → WebSocket Server Settings → Show Connect Info.",
                ),
              );
              return;
            }
            payload.authentication = await computeAuth(
              password,
              hello.authentication.salt,
              hello.authentication.challenge,
            );
          }
          ws.send(JSON.stringify({ op: 1, d: payload }));
          return;
        }
        if (parsed.op === 2) {
          this.identified = true;
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve();
          return;
        }
        if (parsed.op === 7) {
          const payload = parsed.d as RequestResponsePayload;
          const waiter = this.pending.get(payload.requestId);
          if (!waiter) return;
          this.pending.delete(payload.requestId);
          if (payload.requestStatus.result) {
            waiter.resolve(payload.responseData ?? {});
          } else {
            waiter.reject(
              new Error(
                payload.requestStatus.comment ??
                  `OBS ${payload.requestType} failed (code ${payload.requestStatus.code})`,
              ),
            );
          }
        }
      });
    });
  }

  /**
   * Send a Request, await the matching RequestResponse. `requestData`
   * varies by request type; see the OBS WebSocket protocol docs for the
   * shapes we use.
   */
  private request(
    requestType: string,
    requestData: Record<string, unknown> = {},
    timeoutMs = 5000,
  ): Promise<Record<string, unknown>> {
    if (!this.identified || !this.ws) {
      return Promise.reject(new Error("not connected to OBS"));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          reject(new Error(`OBS ${requestType} timed out`));
        }
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (data) => {
          window.clearTimeout(timer);
          resolve(data);
        },
        reject: (err) => {
          window.clearTimeout(timer);
          reject(err);
        },
      });
      this.ws!.send(
        JSON.stringify({
          op: 6,
          d: { requestType, requestId, requestData },
        }),
      );
    });
  }

  /** Returns the active program (foreground) scene's name. */
  async getCurrentSceneName(): Promise<string> {
    const res = await this.request("GetCurrentProgramScene");
    // OBS 30+ renames this to currentProgramSceneName; 28-29 returned
    // sceneName. Handle both so we work across versions.
    const name =
      (res["currentProgramSceneName"] as string | undefined) ??
      (res["sceneName"] as string | undefined);
    if (!name) throw new Error("OBS didn't return a current scene name");
    return name;
  }

  /** Enumerate scene items — used to check if our source already exists. */
  async getSceneItemList(
    sceneName: string,
  ): Promise<Array<{ sourceName: string; inputKind: string | null }>> {
    const res = await this.request("GetSceneItemList", { sceneName });
    const items = (res["sceneItems"] as Array<Record<string, unknown>>) ?? [];
    return items.map((it) => ({
      sourceName: (it["sourceName"] as string) ?? "",
      inputKind: (it["inputKind"] as string) ?? null,
    }));
  }

  /**
   * Create a Browser Source. If `sceneName` isn't supplied we place it
   * in the current program scene. Returns the created input's name.
   */
  async createBrowserSource(opts: {
    sceneName?: string;
    inputName: string;
    url: string;
    width: number;
    height: number;
    shutdownWhenNotVisible: boolean;
  }): Promise<{ sceneName: string; inputName: string }> {
    const sceneName = opts.sceneName ?? (await this.getCurrentSceneName());
    const inputSettings = {
      url: opts.url,
      width: opts.width,
      height: opts.height,
      // obs-browser calls the "shut down when inactive" setting
      // "shutdown" internally.
      shutdown: opts.shutdownWhenNotVisible,
      // Skip rendering in preview-only scenes by default; spares CPU
      // and matches what a manual user typically configures.
      restart_when_active: true,
    };
    await this.request("CreateInput", {
      sceneName,
      inputName: opts.inputName,
      inputKind: "browser_source",
      inputSettings,
      sceneItemEnabled: true,
    });
    return { sceneName, inputName: opts.inputName };
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // already gone
    }
    this.ws = null;
    this.identified = false;
    // Reject outstanding requests so their promises don't dangle.
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error("OBS connection closed"));
    }
    this.pending.clear();
  }
}
