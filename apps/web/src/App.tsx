import "./App.css";

export function App() {
  return (
    <>
      {/* ambient background glow */}
      <div className="heat-bg" />

      <div className="logo">
        {/* ── HEAT with fire ── */}
        <div className="heat-wrapper">
          {/* flame tongues behind text */}
          <div className="flames">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="flame" />
            ))}
          </div>

          {/* floating ember particles */}
          <div className="embers">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="ember" />
            ))}
          </div>

          <span className="heat">HEAT</span>
        </div>

        {/* ── BROTHERS with cool chrome + sunglasses ── */}
        <div className="brothers-wrapper">
          <span className="sunglasses">😎</span>
          <span className="brothers">BROTHERS</span>
        </div>
      </div>
    </>
  );
}
