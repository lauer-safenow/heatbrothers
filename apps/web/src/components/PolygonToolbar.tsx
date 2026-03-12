type DrawingState = "idle" | "drawing" | "complete";

interface PolygonToolbarProps {
  drawingState: DrawingState;
  vertexCount: number;
  onStartDraw: () => void;
  onFinishDraw: () => void;
  onClear: () => void;
}

export function PolygonToolbar({
  drawingState,
  vertexCount,
  onStartDraw,
  onFinishDraw,
  onClear,
}: PolygonToolbarProps) {
  return (
    <div className="polygon-toolbar">
      {drawingState === "idle" && (
        <button className="poly-btn" onClick={onStartDraw}>
          Draw Polygon
        </button>
      )}
      {drawingState === "drawing" && (
        <>
          <span className="poly-info">{vertexCount} vertices</span>
          <button
            className="poly-btn"
            onClick={onFinishDraw}
            disabled={vertexCount < 3}
          >
            Finish
          </button>
          <button className="poly-btn poly-btn-cancel" onClick={onClear}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
