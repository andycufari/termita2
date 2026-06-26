// Reactive terminal dimensions. Ink re-renders its tree on resize, but it does
// NOT give you the live size as state — so we subscribe to stdout 'resize' and
// expose { columns, rows } that updates the component when the window changes.
import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });

  useEffect(() => {
    if (!stdout) return undefined;
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', onResize);
    onResize(); // sync once on mount in case it changed before we subscribed
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  return size;
}
