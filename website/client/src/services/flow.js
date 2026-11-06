export const initialFlow = {
  step: "choose",
  model: "g3",
  progress: 0,
  phase: "idle",
  error: "",
};
export const busy = (state) =>
  ["transferring", "verifying"].includes(state.step);
export function flowReducer(state, action) {
  switch (action.type) {
    case "MODEL":
      return state.step === "choose" && ["g3", "f3"].includes(action.model)
        ? { ...state, model: action.model }
        : state;
    case "REVIEW":
      return state.step === "choose"
        ? { ...state, step: "review", error: "" }
        : state;
    case "START":
      return state.step === "review"
        ? {
            ...state,
            step: "transferring",
            phase: "entering",
            progress: 0,
            error: "",
          }
        : state;
    case "PROGRESS":
      return busy(state)
        ? {
            ...state,
            step:
              action.phase === "verifying" || action.phase === "confirmed"
                ? "verifying"
                : "transferring",
            phase: action.phase,
            progress: Math.min(100, Math.max(0, action.percent || 0)),
          }
        : state;
    case "DONE":
      return busy(state) && action.confirmed === true
        ? { ...state, step: "complete", phase: "confirmed", progress: 100 }
        : state;
    case "FAIL":
      return busy(state)
        ? { ...state, step: "error", error: action.error }
        : state;
    case "RESET":
      return busy(state) ? state : { ...initialFlow, model: state.model };
    default:
      return state;
  }
}
