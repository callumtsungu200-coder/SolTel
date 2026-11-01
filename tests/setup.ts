import { setLogLevel } from '../src/utils/logger.js';

// Keep test output readable; individual tests capture logs via setLogSink when needed.
setLogLevel('error');
