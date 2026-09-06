
const STATES = {
  IDLE: "IDLE",
  REQUESTING_PERMISSION: "REQUESTING_PERMISSION",
  RECORDING: "RECORDING",
  STOPPING: "STOPPING",
  COMPLETED: "COMPLETED",
  PLAYBACK: "PLAYBACK",
  ERROR: "ERROR",
};

const SOURCE_MODES = {
  OUTPUT: "OUTPUT",
  INPUT: "INPUT",
  BOTH: "BOTH",
};

const SOURCE_META = {
  input: {
    title: "Entrada",
    subtitle: "Você / microfone",
    role: "VOCÊ",
    fieldName: "input_file",
  },
  output: {
    title: "Saída",
    subtitle: "Outras pessoas / sistema",
    role: "OUTRA PESSOA",
    fieldName: "output_file",
  },
};

const DEFAULT_IDLE_MESSAGE =
  "Nenhuma captura ativa. Escolha a fonte de áudio e clique em Iniciar captura.";

const DEFAULT_PLAYBACK_MESSAGE =
  "Os áudios finalizados aparecerão aqui para reprodução local.";

const DEFAULT_UPLOAD_MESSAGE =
  "O áudio pode ser enviado para o backend para processamento e transcrição.";

const UPLOAD_ENDPOINT = "http://127.0.0.1:8000/api/audio";
const UPLOAD_TIMEOUT_MS = 30000;

const UPLOAD_STATES = {
  UPLOAD_IDLE: "UPLOAD_IDLE",
  UPLOAD_LOADING: "UPLOAD_LOADING",
  UPLOAD_PROCESSING: "UPLOAD_PROCESSING",
  UPLOAD_TRANSCRIBING: "UPLOAD_TRANSCRIBING",
  UPLOAD_SUCCESS: "UPLOAD_SUCCESS",
  UPLOAD_ERROR: "UPLOAD_ERROR",
};

const elements = {
  startButton: document.getElementById("start-button"),
  stopButton: document.getElementById("stop-button"),
  stateBadge: document.getElementById("capture-state"),
  statusMessage: document.getElementById("status-message"),
  modeRadios: Array.from(document.querySelectorAll('input[name="source-mode"]')),
  playbackPanel: document.getElementById("playback-panel"),
  playbackSources: document.getElementById("playback-sources"),
  playbackMessage: document.getElementById("playback-message"),
  newRecordingButton: document.getElementById("new-recording-button"),
  uploadPanel: document.getElementById("upload-panel"),
  uploadButton: document.getElementById("upload-button"),
  uploadState: document.getElementById("upload-state"),
  uploadMessage: document.getElementById("upload-message"),
  uploadResult: document.getElementById("upload-result"),
  transcriptionPanel: document.getElementById("transcription-panel"),
  transcriptionMessage: document.getElementById("transcription-message"),
  transcriptionState: document.getElementById("transcription-state"),
  transcriptionSources: document.getElementById("transcription-sources"),
  diagnosticsSources: document.getElementById("diagnostics-sources"),
};

const mimeTypePriority = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

let captureState = STATES.IDLE;
let selectedSourceMode = SOURCE_MODES.OUTPUT;
let activeRecording = null;
let recordedSources = { input: null, output: null };
let stopRequestedBy = null;
let suppressPlaybackEvents = false;
let uploadState = UPLOAD_STATES.UPLOAD_IDLE;
let uploadAbortController = null;
let uploadTimeoutId = null;
let uploadStageTimeoutIds = [];
let uploadTimedOut = false;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getSelectedSourceMode() {
  const selected = elements.modeRadios.find((radio) => radio.checked);
  return selected ? selected.value : SOURCE_MODES.OUTPUT;
}

function setSelectedSourceMode(mode) {
  selectedSourceMode = mode;
  for (const radio of elements.modeRadios) {
    radio.checked = radio.value === mode;
  }
}

function formatApproxDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "-";
  }

  const roundedSeconds = Math.max(0, Math.round(milliseconds / 1000));
  if (roundedSeconds < 60) {
    return `${roundedSeconds} s`;
  }

  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

function formatClockDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
      remainingSeconds,
    ).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "-";
  }

  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const precision = value >= 10 || exponent === 0 ? 0 : 1;

  return `${value.toFixed(precision)} ${units[exponent]}`;
}

function formatUploadSize(bytes) {
  return formatBytes(bytes);
}

function formatSourceTitle(sourceKey) {
  return SOURCE_META[sourceKey]?.title || sourceKey;
}

function formatSourceSubtitle(sourceKey) {
  return SOURCE_META[sourceKey]?.subtitle || "";
}

function formatSourceRole(sourceKey) {
  return SOURCE_META[sourceKey]?.role || sourceKey;
}

function formatSourceFieldName(sourceKey) {
  return SOURCE_META[sourceKey]?.fieldName || "file";
}

function formatSourceModeLabel(sourceMode) {
  switch (sourceMode) {
    case SOURCE_MODES.INPUT:
      return "Somente entrada";
    case SOURCE_MODES.BOTH:
      return "Entrada + saída";
    default:
      return "Somente saída";
  }
}

function formatRecordingDuration(source) {
  if (!source) {
    return "-";
  }

  if (Number.isFinite(source.durationMs)) {
    return formatClockDuration(source.durationMs / 1000);
  }

  return formatApproxDuration(source.startedAt ? performance.now() - source.startedAt : null);
}

function formatSegmentTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "-";
  }

  return formatClockDuration(seconds);
}

function createDownloadFileName(mimeType, sourceKey = "") {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];

  const suffix = sourceKey ? `-${sourceKey}` : "";
  return `audio-transcriber-${parts.join("-")}${suffix}.${getExtensionForMimeType(mimeType)}`;
}

function getExtensionForMimeType(mimeType) {
  const normalizedMimeType = (mimeType || "").toLowerCase();

  if (normalizedMimeType.includes("webm")) {
    return "webm";
  }

  if (normalizedMimeType.includes("mp4")) {
    return "mp4";
  }

  if (normalizedMimeType.includes("ogg")) {
    return "ogg";
  }

  if (normalizedMimeType.includes("wav")) {
    return "wav";
  }

  return "audio";
}

function getCaptureErrorMessage(error, sourceMode = selectedSourceMode) {
  const isBoth = sourceMode === SOURCE_MODES.BOTH;

  if (!error) {
    return isBoth
      ? "Não foi possível iniciar a captura das duas fontes."
      : "Ocorreu um erro inesperado durante a captura.";
  }

  switch (error.name) {
    case "NotAllowedError":
      return sourceMode === SOURCE_MODES.INPUT
        ? "Não foi possível acessar o microfone."
        : sourceMode === SOURCE_MODES.BOTH
          ? "Não foi possível acessar o microfone ou capturar a saída."
          : "Não foi possível capturar o áudio da saída.";
    case "AbortError":
      return sourceMode === SOURCE_MODES.INPUT
        ? "A solicitação de microfone foi cancelada."
        : sourceMode === SOURCE_MODES.BOTH
          ? "A captura de uma das fontes foi cancelada."
          : "A seleção de captura foi cancelada.";
    case "NotFoundError":
      return sourceMode === SOURCE_MODES.INPUT
        ? "Nenhum microfone disponível foi encontrado."
        : sourceMode === SOURCE_MODES.BOTH
          ? "Não foi possível encontrar uma das fontes de áudio."
          : "Nenhuma fonte de captura disponível foi encontrada.";
    case "NotReadableError":
      return sourceMode === SOURCE_MODES.INPUT
        ? "Não foi possível acessar o microfone selecionado."
        : sourceMode === SOURCE_MODES.BOTH
          ? "Não foi possível acessar uma das fontes selecionadas."
          : "Não foi possível acessar a fonte selecionada.";
    case "InvalidStateError":
      return "A captura precisa ser iniciada a partir de uma interação do usuário.";
    case "NotSupportedError":
      return "Este navegador não oferece suporte para gravação nesta configuração.";
    case "SecurityError":
      return "A captura só funciona em um contexto seguro ou permitido.";
    default:
      return isBoth
        ? "Não foi possível iniciar a captura das duas fontes."
        : "Não foi possível capturar o áudio da fonte selecionada.";
  }
}

function getPlaybackMessage(sourceMode) {
  switch (sourceMode) {
    case SOURCE_MODES.INPUT:
      return "Áudio da entrada pronto para reprodução e download local.";
    case SOURCE_MODES.BOTH:
      return "Áudios da entrada e da saída prontos para reprodução e download local.";
    default:
      return "Áudio de saída pronto para reprodução e download local.";
  }
}

function getTranscriptionPanelMessage(sourceMode) {
  switch (sourceMode) {
    case SOURCE_MODES.INPUT:
      return "A transcrição da entrada aparecerá abaixo.";
    case SOURCE_MODES.BOTH:
      return "As transcrições da entrada e da saída aparecerão abaixo.";
    default:
      return "A transcrição da saída aparecerá abaixo.";
  }
}

function getUploadNetworkErrorMessage(error) {
  if (uploadTimedOut) {
    return "O upload demorou demais para responder. Tente novamente.";
  }

  if (error && error.name === "AbortError") {
    return "O upload foi interrompido antes de ser concluído.";
  }

  return "Não foi possível conectar ao backend para enviar o áudio.";
}

function setState(nextState, message, type = "info") {
  captureState = nextState;
  elements.stateBadge.textContent = nextState;
  elements.stateBadge.classList.remove("is-recording", "is-warning", "is-error", "is-playback");

  if (type === "recording") {
    elements.stateBadge.classList.add("is-recording");
  } else if (type === "warning") {
    elements.stateBadge.classList.add("is-warning");
  } else if (type === "error") {
    elements.stateBadge.classList.add("is-error");
  } else if (type === "playback") {
    elements.stateBadge.classList.add("is-playback");
  }

  if (message) {
    elements.statusMessage.textContent = message;
  }

  const isBusy =
    nextState === STATES.REQUESTING_PERMISSION ||
    nextState === STATES.RECORDING ||
    nextState === STATES.STOPPING;

  elements.startButton.disabled = isBusy;
  elements.stopButton.disabled = nextState !== STATES.RECORDING;
}

function setUploadState(nextState, message, type = "info") {
  uploadState = nextState;
  elements.uploadState.textContent = nextState;
  elements.uploadState.classList.remove(
    "is-loading",
    "is-transcribing",
    "is-success",
    "is-error",
  );

  if (type === "loading") {
    elements.uploadState.classList.add("is-loading");
  } else if (type === "transcribing") {
    elements.uploadState.classList.add("is-transcribing");
  } else if (type === "success") {
    elements.uploadState.classList.add("is-success");
  } else if (type === "error") {
    elements.uploadState.classList.add("is-error");
  }

  if (message) {
    elements.uploadMessage.textContent = message;
  }

  elements.uploadButton.disabled = isUploadBusyState(nextState) || !hasRecordedSources();
}

function isUploadBusyState(state) {
  return [
    UPLOAD_STATES.UPLOAD_LOADING,
    UPLOAD_STATES.UPLOAD_PROCESSING,
    UPLOAD_STATES.UPLOAD_TRANSCRIBING,
  ].includes(state);
}

function hasRecordedSources() {
  return Boolean(recordedSources.input || recordedSources.output);
}

function clearUploadStageTimers() {
  while (uploadStageTimeoutIds.length > 0) {
    clearTimeout(uploadStageTimeoutIds.pop());
  }
}

function clearUploadResult() {
  elements.uploadResult.hidden = true;
  elements.uploadResult.innerHTML = "";
}

function clearTranscriptionResult() {
  elements.transcriptionPanel.hidden = true;
  elements.transcriptionState.textContent = "-";
  elements.transcriptionMessage.textContent = DEFAULT_UPLOAD_MESSAGE;
  elements.transcriptionSources.innerHTML = "";
}

function clearPlaybackResult() {
  elements.playbackPanel.hidden = true;
  elements.playbackMessage.textContent = DEFAULT_PLAYBACK_MESSAGE;
  elements.playbackSources.innerHTML = "";
}

function clearDiagnosticsResult() {
  elements.diagnosticsSources.innerHTML = "";
}

function clearUploadUi({ hidePanel = true } = {}) {
  if (uploadTimeoutId) {
    clearTimeout(uploadTimeoutId);
    uploadTimeoutId = null;
  }

  clearUploadStageTimers();
  uploadAbortController = null;
  uploadTimedOut = false;
  clearUploadResult();

  if (hidePanel) {
    elements.uploadPanel.hidden = true;
  }

  elements.uploadMessage.textContent = DEFAULT_UPLOAD_MESSAGE;
  setUploadState(UPLOAD_STATES.UPLOAD_IDLE, DEFAULT_UPLOAD_MESSAGE);
  elements.uploadButton.disabled = !hasRecordedSources();
}

function clearAllRecordedSources() {
  for (const sourceKey of ["input", "output"]) {
    const source = recordedSources[sourceKey];
    if (source && source.objectUrl) {
      URL.revokeObjectURL(source.objectUrl);
    }
    recordedSources[sourceKey] = null;
  }
}

function clearActiveRecording() {
  activeRecording = null;
  stopRequestedBy = null;
}

function resetUiToIdle() {
  clearPlaybackResult();
  clearUploadResult();
  clearTranscriptionResult();
  clearDiagnosticsResult();
  clearUploadUi({ hidePanel: true });
  elements.newRecordingButton.hidden = true;
  elements.uploadPanel.hidden = true;
  setState(STATES.IDLE, DEFAULT_IDLE_MESSAGE);
}

function renderSourceSummaryList(sourcePayload) {
  const rows = [
    ["ID", sourcePayload.id || "-"],
    ["Status", sourcePayload.status || "-"],
    ["Fonte", sourcePayload.source_label || formatSourceTitle(sourcePayload.source)],
    ["Arquivo original", sourcePayload.original_file || "-"],
    ["Arquivo processado", sourcePayload.processed_file || "-"],
    ["Content-Type original", sourcePayload.contentType || "-"],
    ["Content-Type processado", sourcePayload.processed_content_type || "-"],
    ["Formato", sourcePayload.format || "-"],
    ["Sample rate", sourcePayload.sample_rate ? `${sourcePayload.sample_rate} Hz` : "-"],
    ["Canais", sourcePayload.channels ? String(sourcePayload.channels) : "-"],
    ["Tamanho original", formatUploadSize(Number(sourcePayload.original_size))],
    ["Tamanho processado", formatUploadSize(Number(sourcePayload.processed_size))],
  ];

  return rows
    .map(
      ([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `,
    )
    .join("");
}

function renderSegmentsList(segments, sourceKey) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return "";
  }

  const items = segments
    .filter((segment) => segment && typeof segment.text === "string" && segment.text.trim())
    .map((segment) => {
      const start = Number.isFinite(segment.start) ? formatSegmentTime(segment.start) : "-";
      const end = Number.isFinite(segment.end) ? formatSegmentTime(segment.end) : "-";
      return {
        source: sourceKey,
        start,
        end,
        text: segment.text.trim(),
      };
    });

  if (!items.length) {
    return "";
  }

  return `
    <ol class="segment-list">
      ${items
        .map(
          (item) => `
            <li>
              <span class="segment-meta">${escapeHtml(formatSourceTitle(item.source))} · ${escapeHtml(item.start)} → ${escapeHtml(item.end)}</span>
              <span class="segment-text">${escapeHtml(item.text)}</span>
            </li>
          `,
        )
        .join("")}
    </ol>
  `;
}

function renderPlaybackCard(sourceKey, source) {
  const duration = formatRecordingDuration(source);
  const mimeType = source.mimeType || source.recorderMimeType || source.blob?.type || "application/octet-stream";
  const downloadName = source.downloadName || createDownloadFileName(mimeType, sourceKey);
  const objectUrl = source.objectUrl || "";

  return `
    <article class="source-card source-card--playback" data-source="${escapeHtml(sourceKey)}">
      <div class="source-card-header">
        <div>
          <h3>${escapeHtml(formatSourceTitle(sourceKey))}</h3>
          <p>${escapeHtml(formatSourceSubtitle(sourceKey))}</p>
        </div>
        <span class="duration-pill">${escapeHtml(duration)}</span>
      </div>
      <audio controls preload="metadata" data-source="${escapeHtml(sourceKey)}" src="${escapeHtml(objectUrl)}"></audio>
      <div class="source-card-actions">
        <a class="action-button" href="${escapeHtml(objectUrl)}" download="${escapeHtml(downloadName)}">Baixar áudio</a>
      </div>
    </article>
  `;
}

function renderPlaybackSources() {
  const sources = [];
  if (recordedSources.input) {
    sources.push(renderPlaybackCard("input", recordedSources.input));
  }
  if (recordedSources.output) {
    sources.push(renderPlaybackCard("output", recordedSources.output));
  }

  elements.playbackPanel.hidden = sources.length === 0;
  elements.playbackMessage.textContent = getPlaybackMessage(selectedSourceMode);
  elements.playbackSources.innerHTML = sources.join("");

  const audioElements = Array.from(elements.playbackSources.querySelectorAll("audio"));
  for (const audioElement of audioElements) {
    const sourceKey = audioElement.dataset.source;
    audioElement.addEventListener("play", () => handlePlaybackPlay(sourceKey));
    audioElement.addEventListener("pause", () => handlePlaybackPause(sourceKey));
    audioElement.addEventListener("ended", () => handlePlaybackEnded(sourceKey));
    audioElement.addEventListener("loadedmetadata", () => handlePlaybackMetadataLoaded(sourceKey));
    audioElement.addEventListener("durationchange", () => handlePlaybackMetadataLoaded(sourceKey));
  }
}

function renderDiagnosticsSources() {
  const sources = [];

  for (const sourceKey of ["input", "output"]) {
    const source = recordedSources[sourceKey];
    if (!source) {
      continue;
    }

    sources.push(`
      <article class="source-card source-card--diagnostics">
        <div class="source-card-header">
          <div>
            <h3>${escapeHtml(formatSourceTitle(sourceKey))}</h3>
            <p>${escapeHtml(formatSourceSubtitle(sourceKey))}</p>
          </div>
          <span class="duration-pill">${escapeHtml(formatRecordingDuration(source))}</span>
        </div>
        <dl class="source-metadata">
          <div><dt>Blob</dt><dd>${escapeHtml(formatBytes(source.blob?.size || 0))}</dd></div>
          <div><dt>MIME type</dt><dd>${escapeHtml(source.mimeType || source.blob?.type || "-")}</dd></div>
          <div><dt>Duração</dt><dd>${escapeHtml(formatRecordingDuration(source))}</dd></div>
        </dl>
      </article>
    `);
  }

  elements.diagnosticsSources.innerHTML = sources.join("");
}

function renderTranscriptionSources(payload) {
  const cards = [];

  if (payload.source_mode === SOURCE_MODES.BOTH) {
    for (const sourceKey of ["input", "output"]) {
      const sourcePayload = payload[sourceKey];
      if (!sourcePayload) {
        continue;
      }

      const segments = renderSegmentsList(sourcePayload.segments || [], sourceKey);
      cards.push(`
        <article class="source-card source-card--transcription">
          <div class="source-card-header">
            <div>
              <h3>${escapeHtml(formatSourceTitle(sourceKey))}</h3>
              <p>${escapeHtml(formatSourceSubtitle(sourceKey))}</p>
            </div>
            <span class="transcription-badge">${escapeHtml(formatSourceRole(sourceKey))}</span>
          </div>
          <pre class="transcription-text">${escapeHtml(sourcePayload.text || "-")}</pre>
          ${segments}
        </article>
      `);
    }

    const combinedSegments = [];
    for (const sourceKey of ["input", "output"]) {
      const sourcePayload = payload[sourceKey];
      if (!sourcePayload || !Array.isArray(sourcePayload.segments)) {
        continue;
      }

      for (const segment of sourcePayload.segments) {
        if (!segment || !segment.text || !String(segment.text).trim()) {
          continue;
        }

        combinedSegments.push({
          sourceKey,
          start: Number.isFinite(segment.start) ? segment.start : null,
          end: Number.isFinite(segment.end) ? segment.end : null,
          text: String(segment.text).trim(),
        });
      }
    }

    const hasTimeline = combinedSegments.some((segment) => Number.isFinite(segment.start));
    if (hasTimeline) {
      combinedSegments.sort((a, b) => {
        if (!Number.isFinite(a.start) && !Number.isFinite(b.start)) {
          return 0;
        }
        if (!Number.isFinite(a.start)) {
          return 1;
        }
        if (!Number.isFinite(b.start)) {
          return -1;
        }
        return a.start - b.start;
      });

      cards.push(`
        <article class="source-card source-card--transcription">
          <div class="source-card-header">
            <div>
              <h3>Linha do tempo</h3>
              <p>Visão combinada das duas fontes.</p>
            </div>
            <span class="transcription-badge">COMBINED</span>
          </div>
          <ol class="segment-list">
            ${combinedSegments
              .map(
                (segment) => `
                  <li>
                    <span class="segment-meta">${escapeHtml(formatSourceTitle(segment.sourceKey))}${Number.isFinite(segment.start) ? ` · ${escapeHtml(formatSegmentTime(segment.start))}` : ""}${Number.isFinite(segment.end) ? ` → ${escapeHtml(formatSegmentTime(segment.end))}` : ""}</span>
                    <span class="segment-text">${escapeHtml(segment.text)}</span>
                  </li>
                `,
              )
              .join("")}
          </ol>
        </article>
      `);
    }
  } else {
    const sourceKey = payload.source === "input" ? "input" : "output";
    const segments = renderSegmentsList(payload.segments || [], sourceKey);
    cards.push(`
      <article class="source-card source-card--transcription">
        <div class="source-card-header">
          <div>
            <h3>${escapeHtml(formatSourceTitle(sourceKey))}</h3>
            <p>${escapeHtml(formatSourceSubtitle(sourceKey))}</p>
          </div>
          <span class="transcription-badge">${escapeHtml(formatSourceRole(sourceKey))}</span>
        </div>
        <pre class="transcription-text">${escapeHtml(payload.text || "-")}</pre>
        ${segments}
      </article>
    `);
  }

  elements.transcriptionPanel.hidden = cards.length === 0;
  elements.transcriptionMessage.textContent = getTranscriptionPanelMessage(payload.source_mode);
  elements.transcriptionState.textContent = payload.source_mode || "-";
  elements.transcriptionSources.innerHTML = cards.join("");
}

function renderUploadResult(payload) {
  const cards = [];

  if (payload.source_mode === SOURCE_MODES.BOTH) {
    for (const sourceKey of ["input", "output"]) {
      const sourcePayload = payload[sourceKey];
      if (!sourcePayload) {
        continue;
      }

      cards.push(`
        <article class="source-card source-card--upload">
          <div class="source-card-header">
            <div>
              <h3>${escapeHtml(formatSourceTitle(sourceKey))}</h3>
              <p>${escapeHtml(formatSourceSubtitle(sourceKey))}</p>
            </div>
            <span class="transcription-badge">${escapeHtml(sourcePayload.status || payload.status || "-")}</span>
          </div>
          <dl class="source-metadata">
            ${renderSourceSummaryList(sourcePayload)}
          </dl>
        </article>
      `);
    }
  } else {
    cards.push(`
      <article class="source-card source-card--upload">
        <div class="source-card-header">
          <div>
            <h3>${escapeHtml(formatSourceTitle(payload.source === "input" ? "input" : "output"))}</h3>
            <p>${escapeHtml(formatSourceSubtitle(payload.source === "input" ? "input" : "output"))}</p>
          </div>
          <span class="transcription-badge">${escapeHtml(payload.status || "-")}</span>
        </div>
        <dl class="source-metadata">
          ${renderSourceSummaryList(payload)}
        </dl>
      </article>
    `);
  }

  elements.uploadResult.hidden = false;
  elements.uploadResult.innerHTML = cards.join("");
}

function createSession(sourceKey, stream) {
  const mimeType = selectSupportedMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const session = {
    sourceKey,
    stream,
    recorder,
    chunks: [],
    startedAt: performance.now(),
    durationMs: null,
    mimeType: recorder.mimeType || mimeType || "application/octet-stream",
    blob: null,
    objectUrl: "",
    downloadName: "",
    finalized: false,
  };

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      session.chunks.push(event.data);
    }
  };

  recorder.onstop = () => {
    finalizeSession(sourceKey);
  };

  recorder.onerror = () => {
    abortRecording("Ocorreu um erro inesperado durante a gravação.");
  };

  stream.getTracks().forEach((track) => {
    track.onended = () => handleTrackEnded(sourceKey);
  });

  recorder.start();
  return session;
}

function selectSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  return mimeTypePriority.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

function stopStream(stream) {
  if (!stream) {
    return;
  }

  stream.getTracks().forEach((track) => track.stop());
}

function clearRecordedSessionEntry(sourceKey) {
  const source = recordedSources[sourceKey];
  if (source && source.objectUrl) {
    URL.revokeObjectURL(source.objectUrl);
  }
  recordedSources[sourceKey] = null;
}

function clearRecordedSession() {
  suppressPlaybackEvents = true;
  for (const sourceKey of ["input", "output"]) {
    const source = recordedSources[sourceKey];
    if (source && source.audioElement) {
      source.audioElement.pause();
    }
  }
  suppressPlaybackEvents = false;

  clearAllRecordedSources();
  clearPlaybackResult();
  clearUploadResult();
  clearTranscriptionResult();
  clearDiagnosticsResult();
  clearUploadUi({ hidePanel: true });
  activeRecording = null;
  stopRequestedBy = null;
  elements.newRecordingButton.hidden = true;
  setState(STATES.IDLE, DEFAULT_IDLE_MESSAGE);
}

function setRecordedSource(sourceKey, session) {
  clearRecordedSessionEntry(sourceKey);
  const mimeType = session.blob.type || session.mimeType || "application/octet-stream";
  session.mimeType = mimeType;
  session.downloadName = createDownloadFileName(mimeType, sourceKey);
  session.objectUrl = URL.createObjectURL(session.blob);
  recordedSources[sourceKey] = session;
}

function renderPlaybackState() {
  renderPlaybackSources();
  renderDiagnosticsSources();
  elements.newRecordingButton.hidden = !hasRecordedSources();
  elements.uploadPanel.hidden = !hasRecordedSources();
  elements.uploadButton.disabled = !hasRecordedSources() || uploadState === UPLOAD_STATES.UPLOAD_LOADING;
  elements.uploadMessage.textContent = DEFAULT_UPLOAD_MESSAGE;
}

function renderCompletedState() {
  renderPlaybackState();
  elements.playbackMessage.textContent = getPlaybackMessage(selectedSourceMode);
  elements.transcriptionPanel.hidden = true;
  setState(
    STATES.COMPLETED,
    stopRequestedBy === "external"
      ? "A captura foi encerrada pela interface do navegador."
      : "Gravação finalizada. O áudio já está pronto para ouvir, baixar ou enviar.",
  );
}

function finalizeSession(sourceKey) {
  const recording = activeRecording;
  if (!recording || recording.aborted) {
    return;
  }

  const session = recording.sessions[sourceKey];
  if (!session || session.finalized) {
    return;
  }

  session.durationMs = session.startedAt ? performance.now() - session.startedAt : null;
  session.blob = new Blob(session.chunks, { type: session.mimeType || "application/octet-stream" });
  session.mimeType = session.blob.type || session.mimeType || "application/octet-stream";
  session.finalized = true;
  setRecordedSource(sourceKey, session);

  recording.completedCount += 1;

  if (recording.completedCount >= recording.expectedSources.length) {
    activeRecording = null;
    renderCompletedState();
  } else {
    renderPlaybackState();
  }
}

function abortRecording(message) {
  if (activeRecording) {
    activeRecording.aborted = true;
  }

  const currentRecording = activeRecording;
  if (currentRecording) {
    for (const sourceKey of currentRecording.expectedSources) {
      const session = currentRecording.sessions[sourceKey];
      if (session && session.recorder && session.recorder.state !== "inactive") {
        try {
          session.recorder.stop();
        } catch {
          // noop
        }
      }
      stopStream(session?.stream);
    }
  }

  activeRecording = null;
  renderPlaybackState();
  renderDiagnosticsSources();
  clearUploadUi({ hidePanel: true });
  clearTranscriptionResult();
  setState(STATES.ERROR, message, "error");
}

function handleTrackEnded(sourceKey) {
  if (!activeRecording || captureState !== STATES.RECORDING) {
    return;
  }

  if (activeRecording.mode === SOURCE_MODES.BOTH) {
    abortRecording(
      sourceKey === "input"
        ? "Não foi possível manter a captura do microfone."
        : "Não foi possível capturar o áudio da saída.",
    );
    return;
  }

  stopRecording("external");
}

function handlePlaybackPlay() {
  if (suppressPlaybackEvents || !hasRecordedSources()) {
    return;
  }

  setState(
    STATES.PLAYBACK,
    "Reprodução em andamento. Use os controles para pausar ou continuar.",
    "playback",
  );
}

function handlePlaybackPause() {
  if (suppressPlaybackEvents || !hasRecordedSources()) {
    return;
  }

  if (!isAnyPlaybackActive()) {
    setState(
      STATES.COMPLETED,
      "Reprodução pausada. O áudio continua disponível para reprodução e download.",
    );
  }
}

function handlePlaybackEnded() {
  if (suppressPlaybackEvents || !hasRecordedSources()) {
    return;
  }

  if (!isAnyPlaybackActive()) {
    setState(
      STATES.COMPLETED,
      "Reprodução concluída. Você pode ouvir novamente, baixar os áudios ou criar uma nova gravação.",
    );
  }
}

function handlePlaybackMetadataLoaded() {
  renderPlaybackState();
}

function isAnyPlaybackActive() {
  return Array.from(elements.playbackSources.querySelectorAll("audio")).some((audio) => !audio.paused && !audio.ended);
}

function handleDownloadClick(event) {
  const link = event.currentTarget;
  if (!link.href) {
    event.preventDefault();
  }
}

function clearUploadStageAndTimers() {
  if (uploadTimeoutId) {
    clearTimeout(uploadTimeoutId);
    uploadTimeoutId = null;
  }

  clearUploadStageTimers();
  uploadAbortController = null;
  uploadTimedOut = false;
}

function prepareUploadUi() {
  elements.uploadPanel.hidden = false;
  clearUploadResult();
  elements.uploadButton.disabled = !hasRecordedSources();
  setUploadState(
    UPLOAD_STATES.UPLOAD_IDLE,
    "Áudio pronto para enviar, processar e transcrever.",
  );
}

function getUploadErrorMessage(status, payload) {
  const backendMessage = payload && typeof payload.message === "string" ? payload.message.trim() : "";

  if (backendMessage) {
    return backendMessage;
  }

  switch (status) {
    case 400:
      return "O backend rejeitou a requisição porque os arquivos enviados são inválidos ou incompletos.";
    case 413:
      return "O arquivo enviado excede o limite permitido de 50 MB.";
    case 415:
      return "O formato de áudio enviado não é aceito pelo backend.";
    case 503:
      return "O backend não conseguiu disponibilizar o processamento ou a transcrição.";
    case 500:
      return "O backend encontrou um erro ao processar ou transcrever o áudio.";
    default:
      return "O upload falhou. Tente novamente.";
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Resposta JSON inválida do backend.");
  }
}

function getSourcePayloadFromResponse(payload, sourceKey) {
  if (payload.source_mode === SOURCE_MODES.BOTH) {
    return payload[sourceKey];
  }

  return payload;
}

async function uploadRecording() {
  if (!hasRecordedSources() || isUploadBusyState(uploadState)) {
    return;
  }

  const formData = new FormData();
  formData.append("source_mode", selectedSourceMode);

  if (selectedSourceMode === SOURCE_MODES.BOTH) {
    formData.append(
      "input_file",
      recordedSources.input.blob,
      recordedSources.input.downloadName,
    );
    formData.append(
      "output_file",
      recordedSources.output.blob,
      recordedSources.output.downloadName,
    );
  } else {
    const sourceKey = selectedSourceMode === SOURCE_MODES.INPUT ? "input" : "output";
    formData.append(
      "file",
      recordedSources[sourceKey].blob,
      recordedSources[sourceKey].downloadName,
    );
  }

  clearUploadStageAndTimers();
  uploadAbortController = new AbortController();
  uploadTimedOut = false;
  uploadTimeoutId = window.setTimeout(() => {
    uploadTimedOut = true;
    uploadAbortController?.abort();
  }, UPLOAD_TIMEOUT_MS);

  setUploadState(
    UPLOAD_STATES.UPLOAD_LOADING,
    "Enviando áudio para o backend...",
    "loading",
  );
  clearUploadResult();
  clearTranscriptionResult();

  uploadStageTimeoutIds.push(
    window.setTimeout(() => {
      if (uploadState === UPLOAD_STATES.UPLOAD_LOADING) {
        setUploadState(
          UPLOAD_STATES.UPLOAD_PROCESSING,
          "Processando áudio no backend...",
          "loading",
        );
      }
    }, 350),
  );

  uploadStageTimeoutIds.push(
    window.setTimeout(() => {
      if (
        uploadState === UPLOAD_STATES.UPLOAD_LOADING ||
        uploadState === UPLOAD_STATES.UPLOAD_PROCESSING
      ) {
        setUploadState(
          UPLOAD_STATES.UPLOAD_TRANSCRIBING,
          "Transcrevendo áudio no backend...",
          "transcribing",
        );
      }
    }, 1200),
  );

  try {
    const response = await fetch(UPLOAD_ENDPOINT, {
      method: "POST",
      body: formData,
      signal: uploadAbortController.signal,
    });

    clearUploadStageAndTimers();

    let payload;
    try {
      payload = await readJsonResponse(response);
    } catch {
      setUploadState(
        UPLOAD_STATES.UPLOAD_ERROR,
        "A resposta do backend não pôde ser interpretada.",
        "error",
      );
      return;
    }

    if (!response.ok) {
      setUploadState(
        UPLOAD_STATES.UPLOAD_ERROR,
        getUploadErrorMessage(response.status, payload),
        "error",
      );
      return;
    }

    if (!payload || typeof payload !== "object") {
      setUploadState(
        UPLOAD_STATES.UPLOAD_ERROR,
        "A resposta do backend não pôde ser interpretada.",
        "error",
      );
      return;
    }

    if (selectedSourceMode === SOURCE_MODES.BOTH) {
      if (!payload.input || !payload.output) {
        setUploadState(
          UPLOAD_STATES.UPLOAD_ERROR,
          "A resposta de transcrição combinada está incompleta.",
          "error",
        );
        return;
      }
    } else if (typeof payload.text !== "string" || !payload.text.trim()) {
      setUploadState(
        UPLOAD_STATES.UPLOAD_ERROR,
        "A transcrição recebida pelo backend está vazia.",
        "error",
      );
      return;
    }

    renderUploadResult(payload);
    renderTranscriptionResult(payload);
    setUploadState(
      UPLOAD_STATES.UPLOAD_SUCCESS,
      "Transcrição concluída.",
      "success",
    );
  } catch (error) {
    setUploadState(
      UPLOAD_STATES.UPLOAD_ERROR,
      getUploadNetworkErrorMessage(error),
      "error",
    );
  } finally {
    clearUploadStageAndTimers();
  }
}

