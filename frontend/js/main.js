const STATES = {
  IDLE: "IDLE",
  REQUESTING_PERMISSION: "REQUESTING_PERMISSION",
  RECORDING: "RECORDING",
  STOPPING: "STOPPING",
  COMPLETED: "COMPLETED",
  PLAYBACK: "PLAYBACK",
  ERROR: "ERROR",
};

const DEFAULT_IDLE_MESSAGE =
  "Nenhuma captura ativa. Clique em Iniciar captura para escolher uma fonte com áudio.";

const DEFAULT_PLAYBACK_MESSAGE =
  "O áudio finalizado aparecerá aqui para reprodução local.";

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
  blobSize: document.getElementById("blob-size"),
  blobType: document.getElementById("blob-type"),
  blobDuration: document.getElementById("blob-duration"),
  playbackPanel: document.getElementById("playback-panel"),
  playbackAudio: document.getElementById("playback-audio"),
  playbackMessage: document.getElementById("playback-message"),
  playbackDuration: document.getElementById("playback-duration"),
  downloadLink: document.getElementById("download-link"),
  newRecordingButton: document.getElementById("new-recording-button"),
  uploadPanel: document.getElementById("upload-panel"),
  uploadButton: document.getElementById("upload-button"),
  uploadState: document.getElementById("upload-state"),
  uploadMessage: document.getElementById("upload-message"),
  uploadResult: document.getElementById("upload-result"),
  uploadId: document.getElementById("upload-id"),
  uploadOriginalFile: document.getElementById("upload-original-file"),
  uploadProcessedFile: document.getElementById("upload-processed-file"),
  uploadFormat: document.getElementById("upload-format"),
  uploadSampleRate: document.getElementById("upload-sample-rate"),
  uploadChannels: document.getElementById("upload-channels"),
  uploadContentType: document.getElementById("upload-content-type"),
  uploadSize: document.getElementById("upload-size"),
  uploadProcessedSize: document.getElementById("upload-processed-size"),
  uploadProcessedContentType: document.getElementById(
    "upload-processed-content-type",
  ),
  transcriptionPanel: document.getElementById("transcription-panel"),
  transcriptionMessage: document.getElementById("transcription-message"),
  transcriptionState: document.getElementById("transcription-state"),
  transcriptionText: document.getElementById("transcription-text"),
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
let activeDisplayStream = null;
let activeAudioStream = null;
let recorder = null;
let recordedBlob = null;
let recordedObjectUrl = "";
let recordedMimeType = "";
let selectedMimeType = "";
let chunks = [];
let recordingStartedAt = null;
let recordingDurationMs = null;
let cleanupInProgress = false;
let stopRequestedBy = null;
let suppressAudioEvents = false;
let uploadState = UPLOAD_STATES.UPLOAD_IDLE;
let uploadAbortController = null;
let uploadTimeoutId = null;
let uploadStageTimeoutIds = [];
let uploadTimedOut = false;

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

function getCaptureErrorMessage(error) {
  if (!error) {
    return "Ocorreu um erro inesperado durante a captura.";
  }

  switch (error.name) {
    case "NotAllowedError":
      return "Permissão negada ou captura bloqueada pelo navegador.";
    case "AbortError":
      return "A seleção de captura foi cancelada.";
    case "NotFoundError":
      return "Nenhuma fonte de captura disponível foi encontrada.";
    case "NotReadableError":
      return "Não foi possível acessar a fonte selecionada.";
    case "InvalidStateError":
      return "A captura precisa ser iniciada a partir de uma interação do usuário.";
    case "NotSupportedError":
      return "Este navegador não oferece suporte para gravação nesta configuração.";
    case "SecurityError":
      return "A captura só funciona em um contexto seguro ou permitido.";
    default:
      return "Não foi possível capturar áudio da fonte selecionada.";
  }
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

function createDownloadFileName(mimeType) {
  const now = new Date();
  const parts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ];

  return `audio-transcriber-${parts.join("-")}.${getExtensionForMimeType(mimeType)}`;
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

function updateDiagnostics({ blob = null, mimeType = "-", durationMs = null } = {}) {
  const effectiveDurationMs = Number.isFinite(durationMs) ? durationMs : recordingDurationMs;
  const durationLabel = blob
    ? formatApproxDuration(effectiveDurationMs)
    : "-";

  elements.blobSize.textContent = blob ? formatBytes(blob.size) : "Sem gravação";
  elements.blobType.textContent = blob ? mimeType : "-";
  elements.blobDuration.textContent = durationLabel;
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

  elements.uploadButton.disabled =
    isUploadBusyState(nextState) || !recordedBlob;
}

function isUploadBusyState(state) {
  return [
    UPLOAD_STATES.UPLOAD_LOADING,
    UPLOAD_STATES.UPLOAD_PROCESSING,
    UPLOAD_STATES.UPLOAD_TRANSCRIBING,
  ].includes(state);
}

function clearUploadStageTimers() {
  while (uploadStageTimeoutIds.length > 0) {
    clearTimeout(uploadStageTimeoutIds.pop());
  }
}

function clearUploadResult() {
  elements.uploadResult.hidden = true;
  elements.uploadId.textContent = "-";
  elements.uploadOriginalFile.textContent = "-";
  elements.uploadProcessedFile.textContent = "-";
  elements.uploadFormat.textContent = "-";
  elements.uploadSampleRate.textContent = "-";
  elements.uploadChannels.textContent = "-";
  elements.uploadContentType.textContent = "-";
  elements.uploadSize.textContent = "-";
  elements.uploadProcessedSize.textContent = "-";
  elements.uploadProcessedContentType.textContent = "-";
}

function clearTranscriptionResult() {
  elements.transcriptionPanel.hidden = true;
  elements.transcriptionState.textContent = "-";
  elements.transcriptionText.textContent = "-";
  elements.transcriptionMessage.textContent =
    "A transcrição retornada pelo backend aparecerá aqui.";
}

function clearUploadUi({ hidePanel = true, hasRecording = false } = {}) {
  if (uploadTimeoutId) {
    clearTimeout(uploadTimeoutId);
    uploadTimeoutId = null;
  }

  clearUploadStageTimers();
  uploadAbortController = null;
  uploadTimedOut = false;
  clearUploadResult();
  clearTranscriptionResult();

  if (hidePanel) {
    elements.uploadPanel.hidden = true;
  }

  elements.uploadMessage.textContent = DEFAULT_UPLOAD_MESSAGE;
  setUploadState(UPLOAD_STATES.UPLOAD_IDLE, DEFAULT_UPLOAD_MESSAGE);
  elements.uploadButton.disabled = !hasRecording;
}

function prepareUploadUi() {
  elements.uploadPanel.hidden = false;
  clearUploadResult();
  clearTranscriptionResult();
  elements.uploadButton.disabled = false;
  setUploadState(
    UPLOAD_STATES.UPLOAD_IDLE,
    "Áudio pronto para enviar, processar e transcrever.",
  );
}

function renderUploadResult(payload) {
  elements.uploadResult.hidden = false;
  elements.uploadId.textContent = payload.id || "-";
  elements.uploadOriginalFile.textContent = payload.original_file || "-";
  elements.uploadProcessedFile.textContent = payload.processed_file || "-";
  elements.uploadFormat.textContent = payload.format || "-";
  elements.uploadSampleRate.textContent = payload.sample_rate
    ? `${payload.sample_rate} Hz`
    : "-";
  elements.uploadChannels.textContent = payload.channels ? String(payload.channels) : "-";
  elements.uploadContentType.textContent = payload.contentType || "-";
  elements.uploadSize.textContent = formatUploadSize(Number(payload.original_size));
  elements.uploadProcessedSize.textContent = formatUploadSize(Number(payload.processed_size));
  elements.uploadProcessedContentType.textContent =
    payload.processed_content_type || "-";
}

function renderTranscriptionResult(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";

  elements.transcriptionPanel.hidden = false;
  elements.transcriptionState.textContent = "READY";
  elements.transcriptionMessage.textContent =
    "A transcrição concluída pelo backend está disponível abaixo.";
  elements.transcriptionText.textContent = normalizedText || "-";
}

function getUploadErrorMessage(status, payload) {
  const backendMessage =
    payload && typeof payload.message === "string" ? payload.message.trim() : "";

  if (backendMessage) {
    return backendMessage;
  }

  switch (status) {
    case 400:
      return "O backend rejeitou o upload porque nenhum arquivo válido foi enviado.";
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

function getUploadNetworkErrorMessage(error) {
  if (uploadTimedOut) {
    return "O upload demorou demais para responder. Tente novamente.";
  }

  if (error && error.name === "AbortError") {
    return "O upload foi interrompido antes de ser concluído.";
  }

  return "Não foi possível conectar ao backend para enviar o áudio.";
}

function getUploadFileName() {
  return createDownloadFileName(recordedMimeType || recordedBlob?.type || "");
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

async function uploadRecording() {
  if (!recordedBlob || uploadState === UPLOAD_STATES.UPLOAD_LOADING) {
    return;
  }

  const fileName = getUploadFileName();
  const formData = new FormData();
  formData.append("file", recordedBlob, fileName);

  clearUploadStageTimers();
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
  elements.uploadResult.hidden = true;
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
    const responsePromise = fetch(UPLOAD_ENDPOINT, {
      method: "POST",
      body: formData,
      signal: uploadAbortController.signal,
    });

    elements.uploadMessage.textContent = "Processando áudio no backend...";

    const response = await responsePromise;

    if (uploadTimeoutId) {
      clearTimeout(uploadTimeoutId);
      uploadTimeoutId = null;
    }

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

    if (typeof payload.text !== "string" || !payload.text.trim()) {
      setUploadState(
        UPLOAD_STATES.UPLOAD_ERROR,
        "A transcrição recebida pelo backend está vazia.",
        "error",
      );
      return;
    }

    renderUploadResult(payload);
    renderTranscriptionResult(payload.text);
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
    if (uploadTimeoutId) {
      clearTimeout(uploadTimeoutId);
      uploadTimeoutId = null;
    }
    clearUploadStageTimers();
    uploadAbortController = null;
    uploadTimedOut = false;
  }
}

function updatePlaybackDurationLabel(durationSeconds) {
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const realDuration = formatClockDuration(durationSeconds);
    elements.playbackDuration.textContent = realDuration;
    elements.blobDuration.textContent = realDuration;
    return;
  }

  const fallbackDuration = formatApproxDuration(recordingDurationMs);
  elements.playbackDuration.textContent = fallbackDuration;
  if (recordedBlob) {
    elements.blobDuration.textContent = fallbackDuration;
  }
}

function clearPlayerUi() {
  suppressAudioEvents = true;
  elements.playbackAudio.pause();
  elements.playbackAudio.removeAttribute("src");
  elements.playbackAudio.load();
  suppressAudioEvents = false;

  elements.playbackPanel.hidden = true;
  elements.playbackAudio.hidden = true;
  elements.downloadLink.hidden = true;
  elements.newRecordingButton.hidden = true;
  elements.downloadLink.removeAttribute("href");
  elements.downloadLink.removeAttribute("download");
  elements.playbackMessage.textContent = DEFAULT_PLAYBACK_MESSAGE;
  elements.playbackDuration.textContent = "-";
}

function revokeRecordedObjectUrl() {
  if (!recordedObjectUrl) {
    return;
  }

  URL.revokeObjectURL(recordedObjectUrl);
  recordedObjectUrl = "";
}

function clearRecordedSession({ keepMessage = false } = {}) {
  suppressAudioEvents = true;
  elements.playbackAudio.pause();
  suppressAudioEvents = false;

  clearPlayerUi();
  revokeRecordedObjectUrl();

  recordedBlob = null;
  recordedMimeType = "";
  selectedMimeType = "";
  chunks = [];
  recordingStartedAt = null;
  recordingDurationMs = null;
  stopRequestedBy = null;
  recorder = null;
  activeAudioStream = null;
  activeDisplayStream = null;

  clearUploadUi({ hasRecording: false });

  updateDiagnostics();

  if (!keepMessage) {
    setState(STATES.IDLE, DEFAULT_IDLE_MESSAGE);
  }
}

function showRecordedSession(blob, mimeType, durationMs) {
  clearPlayerUi();
  revokeRecordedObjectUrl();

  recordedBlob = blob;
  recordedMimeType = blob.type || mimeType || "application/octet-stream";
  recordingDurationMs = durationMs;
  recordedObjectUrl = URL.createObjectURL(blob);

  elements.playbackPanel.hidden = false;
  elements.playbackAudio.hidden = false;
  elements.playbackAudio.src = recordedObjectUrl;
  elements.playbackAudio.load();
  elements.downloadLink.hidden = false;
  elements.downloadLink.href = recordedObjectUrl;
  elements.downloadLink.download = createDownloadFileName(recordedMimeType);
  elements.newRecordingButton.hidden = false;
  elements.playbackMessage.textContent = "Áudio pronto para reprodução e download local.";

  prepareUploadUi();
  updateDiagnostics({
    blob,
    mimeType: recordedMimeType,
    durationMs,
  });
  updatePlaybackDurationLabel(Number.isFinite(durationMs) ? durationMs / 1000 : null);
}

function selectSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  return (
    mimeTypePriority.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || ""
  );
}

function finalizeRecording() {
  const mimeType = selectedMimeType || recorder?.mimeType || "application/octet-stream";
  const durationMs = recordingStartedAt ? performance.now() - recordingStartedAt : null;
  const blobMimeType = mimeType || "application/octet-stream";
  const blob = new Blob(chunks, { type: blobMimeType });

  showRecordedSession(blob, blobMimeType, durationMs);
  cleanupStreams();

  recorder = null;
  activeDisplayStream = null;
  activeAudioStream = null;
  recordingStartedAt = null;

  const completionMessage =
    stopRequestedBy === "external"
      ? "A captura foi encerrada pela interface do navegador."
      : "Gravação finalizada. O áudio já está pronto para ouvir ou baixar.";

  setState(STATES.COMPLETED, completionMessage);
}

function cleanupStreams() {
  cleanupInProgress = true;

  if (activeDisplayStream) {
    activeDisplayStream.getTracks().forEach((track) => track.stop());
    activeDisplayStream = null;
  }

  if (activeAudioStream) {
    activeAudioStream = null;
  }

  cleanupInProgress = false;
}

function stopRecording(reason = "user") {
  if (!recorder || captureState !== STATES.RECORDING) {
    return;
  }

  stopRequestedBy = reason;
  setState(
    STATES.STOPPING,
    reason === "external"
      ? "A interface do navegador encerrou a captura. Finalizando a gravação..."
      : "Finalizando a gravação...",
    "warning",
  );

  try {
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  } catch (error) {
    cleanupStreams();
    setState(STATES.ERROR, getCaptureErrorMessage(error), "error");
  }
}

function handleTrackEnded() {
  if (cleanupInProgress || captureState !== STATES.RECORDING) {
    return;
  }

  stopRecording("external");
}

function handlePlaybackPlay() {
  if (suppressAudioEvents || !recordedBlob) {
    return;
  }

  setState(
    STATES.PLAYBACK,
    "Reprodução em andamento. Use os controles para pausar ou continuar.",
    "playback",
  );
}

function handlePlaybackPause() {
  if (suppressAudioEvents || !recordedBlob) {
    return;
  }

  setState(
    STATES.COMPLETED,
    "Reprodução pausada. O áudio continua disponível para reprodução e download.",
  );
}

function handlePlaybackEnded() {
  if (suppressAudioEvents || !recordedBlob) {
    return;
  }

  elements.playbackAudio.currentTime = 0;
  setState(
    STATES.COMPLETED,
    "Reprodução concluída. Você pode ouvir novamente, baixar o áudio ou criar uma nova gravação.",
  );
}

function handlePlaybackMetadataLoaded() {
  if (!recordedBlob) {
    return;
  }

  updatePlaybackDurationLabel(elements.playbackAudio.duration);
}

function resetToIdle() {
  clearRecordedSession();
}

async function startCapture() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
    setState(
      STATES.ERROR,
      "Este navegador não oferece suporte para captura de tela com áudio.",
      "error",
    );
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    setState(
      STATES.ERROR,
      "Este navegador não oferece suporte para gravação com MediaRecorder.",
      "error",
    );
    return;
  }

  setState(
    STATES.REQUESTING_PERMISSION,
    "Selecione uma fonte de captura. A gravação só iniciará depois da sua escolha.",
    "warning",
  );

  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      systemAudio: "include",
    });

    activeDisplayStream = displayStream;

    const audioTracks = displayStream.getAudioTracks();
    if (!audioTracks.length) {
      cleanupStreams();
      setState(
        STATES.ERROR,
        "A fonte selecionada não forneceu áudio. Tente compartilhar uma aba, janela ou tela com áudio.",
        "error",
      );
      return;
    }

    chunks = [];
    stopRequestedBy = null;
    recordingStartedAt = performance.now();
    recordingDurationMs = null;

    activeAudioStream = new MediaStream(audioTracks);
    selectedMimeType = selectSupportedMimeType();

    recorder = selectedMimeType
      ? new MediaRecorder(activeAudioStream, { mimeType: selectedMimeType })
      : new MediaRecorder(activeAudioStream);

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onstop = () => {
      finalizeRecording();
    };

    recorder.onerror = () => {
      cleanupStreams();
      recorder = null;
      activeAudioStream = null;
      activeDisplayStream = null;
      setState(
        STATES.ERROR,
        "Ocorreu um erro inesperado durante a gravação.",
        "error",
      );
    };

    displayStream.getTracks().forEach((track) => {
      track.onended = handleTrackEnded;
    });

    recorder.start();

    setState(
      STATES.RECORDING,
      "Captura ativa. O áudio está sendo gravado em memória enquanto a fonte permanecer compartilhada.",
      "recording",
    );
  } catch (error) {
    cleanupStreams();
    setState(STATES.ERROR, getCaptureErrorMessage(error), "error");
  }
}

function handleDownloadClick(event) {
  if (!recordedBlob || !recordedObjectUrl) {
    event.preventDefault();
  }
}

function bindEvents() {
  elements.startButton.addEventListener("click", startCapture);
  elements.stopButton.addEventListener("click", () => stopRecording("user"));
  elements.newRecordingButton.addEventListener("click", resetToIdle);
  elements.downloadLink.addEventListener("click", handleDownloadClick);
  elements.uploadButton.addEventListener("click", uploadRecording);
  elements.playbackAudio.addEventListener("play", handlePlaybackPlay);
  elements.playbackAudio.addEventListener("pause", handlePlaybackPause);
  elements.playbackAudio.addEventListener("ended", handlePlaybackEnded);
  elements.playbackAudio.addEventListener("loadedmetadata", handlePlaybackMetadataLoaded);
  elements.playbackAudio.addEventListener("durationchange", handlePlaybackMetadataLoaded);
}

function initialize() {
  clearPlayerUi();
  clearUploadUi({ hasRecording: false });
  updateDiagnostics();
  setState(STATES.IDLE, DEFAULT_IDLE_MESSAGE);
  bindEvents();
}

initialize();
