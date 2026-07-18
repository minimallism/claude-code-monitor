const CACHE_READ_MULTIPLIER = 0.1; 
const CACHE_WRITE_5M_MULTIPLIER = 1.25; 
const CACHE_WRITE_1H_MULTIPLIER = 2.0; 

const DATA_RESIDENCY_US_MULTIPLIER = 1.1; 
const BATCH_DISCOUNT_MULTIPLIER = 0.5; 

const WEB_SEARCH_PER_1K_SEARCHES = 10.0; 
const WEB_FETCH_PER_REQUEST = 0.0; 

const CODE_EXEC_PER_HOUR = 0.05; 
const CODE_EXEC_MIN_MINUTES = 5; 
const CODE_EXEC_FREE_HOURS = 1550; 

function estimateCodeExecHours(codeExecRequests, webSearchRequests, webFetchRequests) {
  if (!codeExecRequests || codeExecRequests <= 0) return 0;
  if ((webSearchRequests || 0) > 0 || (webFetchRequests || 0) > 0) return 0; 
  return (codeExecRequests * CODE_EXEC_MIN_MINUTES) / 60;
}

module.exports = {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  DATA_RESIDENCY_US_MULTIPLIER,
  BATCH_DISCOUNT_MULTIPLIER,
  WEB_SEARCH_PER_1K_SEARCHES,
  WEB_FETCH_PER_REQUEST,
  CODE_EXEC_PER_HOUR,
  CODE_EXEC_MIN_MINUTES,
  CODE_EXEC_FREE_HOURS,
  estimateCodeExecHours,
};
