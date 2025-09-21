import '@testing-library/jest-dom';

// Ensure React Testing Library acts warnings surface during async updates
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
