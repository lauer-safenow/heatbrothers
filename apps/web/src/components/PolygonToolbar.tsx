type DrawingState = "idle" | "drawing" | "complete";

interface PolygonToolbarProps {
  drawingState: DrawingState;
  vertexCount: number;
  filteredCount: number;
  onStartDraw: () => void;
  onFinishDraw: () => void;
  onClear: () => void;
}

export function PolygonToolbar({
  drawingState,
  vertexCount,
  filteredCount,
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
      {drawingState === "complete" && (
        <>
          <span className="poly-info">
            {filteredCount.toLocaleString()} events in area
          </span>
          <button className="poly-btn poly-btn-cancel" onClick={onClear}>
            Clear Polygon
          </button>
        </>
      )}
    </div>
  );
}
