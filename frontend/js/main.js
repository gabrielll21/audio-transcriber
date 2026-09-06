const STATES = {
  IDLE: "IDLE",
  REQUESTING_PERMISSION: "REQUESTING_PERMISSION",
  RECORDING: "RECORDING",
  STOPPING: "STOPPING",
  COMPLETED: "COMPLETED",
  ERROR: "ERROR",
};

const elements = {
  startButton: document.getElementById("start-button"),
  stopButton: document.getElementById("stop-button"),
  stateBadge: document.getElementById("capture-state"),
  statusMessage: document.getElementById("status-message"),
  blobSize: document.getElementById("blob-size"),
  blobType: document.getElementById("blob-type"),
  blobDuration: document.getElementById("blob-duration"),
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
let selectedMimeType = "";
let chunks = [];
let recordingStartedAt = null;
let cleanupInProgress = false;
let stopRequestedBy = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "-";
  }

  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  const precision = value >= 10 || exponent === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[exponent]}`;
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "-";
  }

  const seconds = milliseconds / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes} min ${remainingSeconds.toString().padStart(2, "0")} s`;
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

function setState(nextState, message, type = "info") {
  captureState = nextState;
  elements.stateBadge.textContent = nextState;
  elements.stateBadge.classList.remove("is-recording", "is-warning", "is-error");

  if (type === "recording") {
    elements.stateBadge.classList.add("is-recording");
  } else if (type === "warning") {
    elements.stateBadge.classList.add("is-warning");
  } else if (type === "error") {
    elements.stateBadge.classList.add("is-error");
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
  elements.blobSize.textContent = blob ? formatBytes(blob.size) : "Sem gravação";
  elements.blobType.textContent = blob ? mimeType : "-";
  elements.blobDuration.textContent = blob ? formatDuration(durationMs) : "-";
}

function resetSessionState() {
  chunks = [];
  recordedBlob = null;
  selectedMimeType = "";
  recordingStartedAt = null;
  stopRequestedBy = null;
  updateDiagnostics();
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

function selectSupportedMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return "";
  }

  return (
    mimeTypePriority.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || ""
  );
}

function finalizeRecording() {
  if (recordedBlob) {
    return;
  }

  const mimeType = selectedMimeType || recorder?.mimeType || "application/octet-stream";
  recordedBlob = new Blob(chunks, { type: mimeType });
  const durationMs = recordingStartedAt ? performance.now() - recordingStartedAt : null;

  updateDiagnostics({
    blob: recordedBlob,
    mimeType: recordedBlob.type || mimeType,
    durationMs,
  });

  cleanupStreams();
  recorder = null;
  activeAudioStream = null;
  activeDisplayStream = null;
  recordingStartedAt = null;

  const sourceLabel =
    stopRequestedBy === "external"
      ? "A captura foi encerrada pela interface do navegador."
      : "Gravação finalizada. O Blob foi mantido em memória para as próximas etapas.";

  setState(STATES.COMPLETED, sourceLabel);
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

    resetSessionState();
    activeAudioStream = new MediaStream(audioTracks);

    selectedMimeType = selectSupportedMimeType();

    recorder = selectedMimeType
      ? new MediaRecorder(activeAudioStream, { mimeType: selectedMimeType })
      : new MediaRecorder(activeAudioStream);

    chunks = [];
    recordingStartedAt = performance.now();

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

function bindEvents() {
  elements.startButton.addEventListener("click", startCapture);
  elements.stopButton.addEventListener("click", () => stopRecording("user"));
}

function initialize() {
  updateDiagnostics();
  setState(
    STATES.IDLE,
    "Nenhuma captura ativa. Clique em Iniciar captura para escolher uma fonte com áudio.",
  );
  bindEvents();
}

initialize();
