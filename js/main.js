import { CameraCapture } from "./camera-capture.js";
import { BallScene } from "./ball-scene.js";

const LETTER_COLORS = [
  "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be",
  "#30b0c7", "#007aff", "#5856d6", "#af52de", "#ff2d55",
  "#ff6482", "#ffd60a", "#32ade6",
];

function renderTitle() {
  const title = document.getElementById("home-title");
  const text = "Stuiterkoppen";
  title.innerHTML = "";
  [...text].forEach((char, i) => {
    const span = document.createElement("span");
    span.className = "letter";
    span.textContent = char;
    span.style.color = LETTER_COLORS[i % LETTER_COLORS.length];
    title.appendChild(span);
  });
}

const homeScreen = document.getElementById("home-screen");
const sceneScreen = document.getElementById("scene-screen");
const startBtn = document.getElementById("start-btn");
const klaarBtn = document.getElementById("klaar-btn");
const canvas = document.getElementById("three-canvas");

const cameraCapture = new CameraCapture();
let ballScene = null;

function showHome() {
  sceneScreen.classList.add("hidden");
  homeScreen.classList.remove("hidden");
}

function showScene() {
  homeScreen.classList.add("hidden");
  sceneScreen.classList.remove("hidden");
}

function requestAddBall() {
  cameraCapture.open({
    terugLabel: "Terug",
    skipConfirm: true,
    onConfirm: (photoDataUrl) => {
      if (ballScene) ballScene.addFaceBall(photoDataUrl);
    },
    onCancel: () => {
      // "Terug" from within the scene simply returns to the existing scene.
    },
  });
}

function startNewSession(firstPhotoDataUrl) {
  if (ballScene) ballScene.dispose();
  ballScene = new BallScene(canvas, { onAddRequested: requestAddBall });
  ballScene.addFaceBall(firstPhotoDataUrl);
  ballScene.start();
  showScene();
}

function endSession() {
  if (ballScene) {
    ballScene.dispose();
    ballScene = null;
  }
  showHome();
}

startBtn.addEventListener("click", () => {
  cameraCapture.open({
    terugLabel: "Terug",
    onConfirm: (photoDataUrl) => startNewSession(photoDataUrl),
    onCancel: () => showHome(),
  });
});

klaarBtn.addEventListener("click", () => {
  if (confirm("Weet je het zeker?")) {
    endSession();
  }
});

renderTitle();
showHome();
