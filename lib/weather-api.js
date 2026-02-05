/**
 * Weather API Wrapper
 *
 * Uses Open-Meteo (free, 10k requests/day) as primary source.
 * Provides forecasts and historical data for temperature markets.
 */

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const TOMORROW_API_BASE = 'https://api.tomorrow.io/v4/weather/forecast';
const NWS_API_BASE = 'https://api.weather.gov';
const WEATHERAPI_BASE = 'https://api.weatherapi.com/v1';

// NWS requires a User-Agent header
const NWS_HEADERS = {
  'User-Agent': '(polymarket-weather-bot, weather-bot@example.com)',
  'Accept': 'application/geo+json'
};

// US cities that can use NWS (dynamic detection for new cities)
const US_CITY_KEYS = [
  'nyc', 'new york', 'chicago', 'miami', 'seattle', 'dallas', 'atlanta',
  'denver', 'houston', 'los angeles', 'la', 'philadelphia', 'dc', 'washington dc',
  'las vegas', 'new orleans', 'san francisco', 'austin', 'phoenix'
];

// City coordinates and timezone info
const CITIES = {
  'london':       { lat: 51.5074, lon: -0.1278,  tz: 'Europe/London', unit: 'C' },
  'new york':     { lat: 40.7128, lon: -74.0060, tz: 'America/New_York', unit: 'F' },
  'nyc':          { lat: 40.7128, lon: -74.0060, tz: 'America/New_York', unit: 'F' },
  'atlanta':      { lat: 33.7490, lon: -84.3880, tz: 'America/New_York', unit: 'F' },
  'miami':        { lat: 25.7617, lon: -80.1918, tz: 'America/New_York', unit: 'F' },
  'chicago':      { lat: 41.8781, lon: -87.6298, tz: 'America/Chicago', unit: 'F' },
  'dallas':       { lat: 32.7767, lon: -96.7970, tz: 'America/Chicago', unit: 'F' },
  'seattle':      { lat: 47.6062, lon: -122.3321, tz: 'America/Los_Angeles', unit: 'F' },
  'toronto':      { lat: 43.6532, lon: -79.3832, tz: 'America/Toronto', unit: 'C' },
  'seoul':        { lat: 37.5665, lon: 126.9780, tz: 'Asia/Seoul', unit: 'C' },
  'buenos aires': { lat: -34.6037, lon: -58.3816, tz: 'America/Argentina/Buenos_Aires', unit: 'C' },
  'ankara':       { lat: 39.9334, lon: 32.8597,  tz: 'Europe/Istanbul', unit: 'C' },
  'wellington':   { lat: -41.2866, lon: 174.7756, tz: 'Pacific/Auckland', unit: 'C' },
  'denver':       { lat: 39.7392, lon: -104.9903, tz: 'America/Denver', unit: 'F' },
  'phoenix':      { lat: 33.4484, lon: -112.0740, tz: 'America/Phoenix', unit: 'F' },
  'los angeles':  { lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles', unit: 'F' },
  'la':           { lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles', unit: 'F' },
  // Kalshi-only cities
  'houston':      { lat: 29.7604, lon: -95.3698, tz: 'America/Chicago', unit: 'F' },
  'philadelphia': { lat: 39.9526, lon: -75.1652, tz: 'America/New_York', unit: 'F' },
  'dc':           { lat: 38.9072, lon: -77.0369, tz: 'America/New_York', unit: 'F' },
  'washington dc': { lat: 38.9072, lon: -77.0369, tz: 'America/New_York', unit: 'F' },
  'las vegas':    { lat: 36.1699, lon: -115.1398, tz: 'America/Los_Angeles', unit: 'F' },
  'new orleans':  { lat: 29.9511, lon: -90.0715, tz: 'America/Chicago', unit: 'F' },
  'san francisco': { lat: 37.7749, lon: -122.4194, tz: 'America/Los_Angeles', unit: 'F' },
  'austin':       { lat: 30.2672, lon: -97.7431, tz: 'America/Chicago', unit: 'F' },
};

// Temperature conversions
function celsiusToFahrenheit(c) {
  return (c * 9 / 5) + 32;
}

function fahrenheitToCelsius(f) {
  return (f - 32) * 5 / 9;
}

class WeatherAPI {
  constructor(config = {}) {
    this.log = config.log || console.log;
    this.requestCount = 0;
    this.lastRequestTime = null;
  }

  /**
   * Get city info by name (case insensitive, partial match)
   */
  getCity(cityName) {
    const normalized = cityName.toLowerCase().trim();

    // Exact match
    if (CITIES[normalized]) {
      return { key: normalized, ...CITIES[normalized] };
    }

    // Partial match
    for (const [key, data] of Object.entries(CITIES)) {
      if (normalized.includes(key) || key.includes(normalized)) {
        return { key, ...data };
      }
    }

    return null;
  }

  /**
   * Get all supported cities
   */
  getAllCities() {
    return Object.entries(CITIES).map(([key, data]) => ({
      key,
      ...data,
    }));
  }

  /**
   * Fetch forecast from Open-Meteo
   * Returns forecast for next 7 days
   */
  async getForecast(cityName) {
    const city = this.getCity(cityName);
    if (!city) {
      this.log('warn', `Unknown city: ${cityName}`);
      return null;
    }

    try {
      const url = `${OPEN_METEO_BASE}?` +
        `latitude=${city.lat}&longitude=${city.lon}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max` +
        `&timezone=${encodeURIComponent(city.tz)}` +
        `&forecast_days=16`;

      const resp = await fetch(url);
      this.requestCount++;
      this.lastRequestTime = new Date();

      if (!resp.ok) {
        throw new Error(`Open-Meteo API error: ${resp.status}`);
      }

      const data = await resp.json();

      // Parse into useful format
      const forecasts = [];
      for (let i = 0; i < data.daily.time.length; i++) {
        const highC = data.daily.temperature_2m_max[i];
        const lowC = data.daily.temperature_2m_min[i];
        const precipMm = data.daily.precipitation_sum?.[i] || 0;
        const precipProb = data.daily.precipitation_probability_max?.[i] || 0;

        forecasts.push({
          date: data.daily.time[i],
          city: city.key,
          highC: Math.round(highC * 10) / 10,
          lowC: Math.round(lowC * 10) / 10,
          highF: Math.round(celsiusToFahrenheit(highC) * 10) / 10,
          lowF: Math.round(celsiusToFahrenheit(lowC) * 10) / 10,
          precipitationMm: Math.round(precipMm * 10) / 10,
          precipitationInches: Math.round((precipMm / 25.4) * 100) / 100,
          precipitationProbability: precipProb,
          preferredUnit: city.unit,
          // Confidence based on days out (closer = higher confidence)
          confidence: i === 0 ? 'very-high' : i === 1 ? 'high' : i <= 3 ? 'medium' : 'low',
        });
      }

      return {
        city: city.key,
        timezone: city.tz,
        forecasts,
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      this.log('error', 'Forecast fetch failed', { city: cityName, error: err.message });
      return null;
    }
  }

  /**
   * Get forecast for a specific date
   */
  async getForecastForDate(cityName, targetDate) {
    const forecast = await this.getForecast(cityName);
    if (!forecast) return null;

    const dateStr = typeof targetDate === 'string'
      ? targetDate
      : targetDate.toISOString().split('T')[0];

    const dayForecast = forecast.forecasts.find(f => f.date === dateStr);

    if (!dayForecast) {
      this.log('warn', `No forecast available for ${cityName} on ${dateStr}`);
      return null;
    }

    // For NYC, also get Tomorrow.io forecast for comparison
    const city = this.getCity(cityName);
    if (city && (city.key === 'nyc' || city.key === 'new york') && process.env.TOMORROW_API_KEY) {
      const tomorrowForecast = await this.getTomorrowForecast(city.lat, city.lon, dateStr);
      if (tomorrowForecast) {
        dayForecast.tomorrowForecast = tomorrowForecast;
      }
    }

    return dayForecast;
  }

  /**
   * Get forecast from Tomorrow.io API (NYC only for now)
   * @param {number} lat - Latitude
   * @param {number} lon - Longitude
   * @param {string} dateStr - Target date (YYYY-MM-DD)
   */
  async getTomorrowForecast(lat, lon, dateStr) {
    const apiKey = process.env.TOMORROW_API_KEY;
    if (!apiKey) return null;

    try {
      const url = `${TOMORROW_API_BASE}?location=${lat},${lon}&apikey=${apiKey}`;
      const resp = await fetch(url);
      this.requestCount++;

      if (!resp.ok) {
        this.log('warn', 'Tomorrow.io API error', { status: resp.status });
        return null;
      }

      const data = await resp.json();

      // Find matching date in daily forecast
      if (!data.timelines?.daily) return null;

      const dayForecast = data.timelines.daily.find(d =>
        d.time.startsWith(dateStr)
      );

      if (!dayForecast || !dayForecast.values) return null;

      const highC = dayForecast.values.temperatureMax;
      const highF = celsiusToFahrenheit(highC);

      return {
        highC: Math.round(highC * 10) / 10,
        highF: Math.round(highF * 10) / 10,
        source: 'tomorrow.io',
      };
    } catch (err) {
      this.log('warn', 'Tomorrow.io fetch failed', { error: err.message });
      return null;
    }
  }

  /**
   * Fetch forecast from NWS (US cities only)
   * @param {number} lat - Latitude
   * @param {number} lon - Longitude
   * @param {string} dateStr - Target date YYYY-MM-DD
   */
  async getNWSForecast(lat, lon, dateStr) {
    try {
      // Step 1: Get grid point
      const pointUrl = `${NWS_API_BASE}/points/${lat.toFixed(4)},${lon.toFixed(4)}`;
      const pointResp = await fetch(pointUrl, { headers: NWS_HEADERS });

      if (!pointResp.ok) {
        this.log('warn', 'NWS points API error', { status: pointResp.status });
        return null;
      }

      const pointData = await pointResp.json();
      const forecastUrl = pointData.properties?.forecast;

      if (!forecastUrl) {
        this.log('warn', 'NWS no forecast URL in response');
        return null;
      }

      // Step 2: Get forecast
      const forecastResp = await fetch(forecastUrl, { headers: NWS_HEADERS });
      this.requestCount++;

      if (!forecastResp.ok) {
        this.log('warn', 'NWS forecast API error', { status: forecastResp.status });
        return null;
      }

      const forecastData = await forecastResp.json();
      const periods = forecastData.properties?.periods || [];

      // Find the daytime period for target date
      const targetDate = new Date(dateStr + 'T12:00:00');

      for (const period of periods) {
        if (!period.isDaytime) continue;

        const periodDate = new Date(period.startTime);
        if (periodDate.toDateString() === targetDate.toDateString()) {
          const tempF = period.temperature;
          const tempC = fahrenheitToCelsius(tempF);

          return {
            highF: tempF,
            highC: Math.round(tempC * 10) / 10,
            source: 'nws',
            shortForecast: period.shortForecast,
          };
        }
      }

      return null; // Date not in forecast range
    } catch (err) {
      this.log('warn', 'NWS fetch failed', { error: err.message });
      return null;
    }
  }

  /**
   * Fetch forecast from WeatherAPI.com
   * @param {number} lat - Latitude
   * @param {number} lon - Longitude
   * @param {string} dateStr - Target date YYYY-MM-DD
   */
  async getWeatherAPIForecast(lat, lon, dateStr) {
    const apiKey = process.env.WEATHERAPI_KEY;
    if (!apiKey) {
      return null;
    }

    try {
      // WeatherAPI forecast endpoint (up to 14 days)
      const url = `${WEATHERAPI_BASE}/forecast.json?key=${apiKey}&q=${lat},${lon}&days=14&aqi=no`;

      const resp = await fetch(url);
      this.requestCount++;

      if (!resp.ok) {
        this.log('warn', 'WeatherAPI error', { status: resp.status });
        return null;
      }

      const data = await resp.json();

      // Find forecast for target date
      const forecastDays = data.forecast?.forecastday || [];
      const dayForecast = forecastDays.find(d => d.date === dateStr);

      if (!dayForecast) {
        return null; // Date not in forecast range
      }

      return {
        highF: dayForecast.day.maxtemp_f,
        highC: dayForecast.day.maxtemp_c,
        source: 'weatherapi',
      };
    } catch (err) {
      this.log('warn', 'WeatherAPI fetch failed', { error: err.message });
      return null;
    }
  }

  /**
   * Check if a city is in the US (for NWS eligibility)
   */
  isUSCity(cityKey) {
    return US_CITY_KEYS.includes(cityKey.toLowerCase());
  }

  /**
   * Get forecast from all available sources for a city/date
   * Returns individual forecasts + consensus
   */
  async getMultiSourceForecast(cityName, targetDate) {
    const city = this.getCity(cityName);
    if (!city) return null;

    const dateStr = typeof targetDate === 'string'
      ? targetDate
      : targetDate.toISOString().split('T')[0];

    const isUSCity = this.isUSCity(city.key);

    const forecasts = {};
    const temps = [];

    // Always fetch Open-Meteo (primary)
    const openMeteo = await this.getForecastForDate(cityName, dateStr);
    if (openMeteo) {
      forecasts.openMeteo = {
        highF: openMeteo.highF,
        highC: openMeteo.highC,
        confidence: openMeteo.confidence,
        source: 'open-meteo',
      };
      temps.push(openMeteo.highF);
    }

    // Fetch NWS for US cities
    if (isUSCity) {
      const nws = await this.getNWSForecast(city.lat, city.lon, dateStr);
      if (nws) {
        forecasts.nws = nws;
        temps.push(nws.highF);
      }
    }

    // Fetch WeatherAPI for all cities (if API key configured)
    const weatherApi = await this.getWeatherAPIForecast(city.lat, city.lon, dateStr);
    if (weatherApi) {
      forecasts.weatherApi = weatherApi;
      temps.push(weatherApi.highF);
    }

    // Calculate consensus
    const sourceCount = temps.length;
    if (sourceCount === 0) return null;

    const avgTempF = temps.reduce((a, b) => a + b, 0) / sourceCount;
    const spread = sourceCount > 1 ? Math.max(...temps) - Math.min(...temps) : 0;

    // Determine consensus confidence based on spread
    let consensusConfidence;
    if (sourceCount >= 2 && spread <= 1) {
      consensusConfidence = 'very-high';  // Sources agree within 1°F
    } else if (sourceCount >= 2 && spread <= 2) {
      consensusConfidence = 'high';       // Sources agree within 2°F
    } else if (sourceCount >= 2 && spread <= 4) {
      consensusConfidence = 'medium';     // Sources agree within 4°F
    } else {
      consensusConfidence = 'low';        // Large disagreement or single source
    }

    // Use Open-Meteo confidence as base, upgrade if consensus agrees
    const baseConfidence = forecasts.openMeteo?.confidence || 'low';

    return {
      city: city.key,
      date: dateStr,
      sources: forecasts,
      sourceCount,
      consensus: {
        highF: Math.round(avgTempF * 10) / 10,
        highC: Math.round(fahrenheitToCelsius(avgTempF) * 10) / 10,
        spread: Math.round(spread * 10) / 10,
        confidence: consensusConfidence,
      },
      // For backwards compatibility, expose primary forecast
      highF: forecasts.openMeteo?.highF || avgTempF,
      highC: forecasts.openMeteo?.highC || fahrenheitToCelsius(avgTempF),
      preferredUnit: city.unit,
      confidence: this.upgradeConfidence(baseConfidence, consensusConfidence),
      // Pass through Tomorrow.io if it was fetched (NYC)
      tomorrowForecast: openMeteo?.tomorrowForecast || null,
    };
  }

  /**
   * Upgrade confidence if consensus supports it
   */
  upgradeConfidence(baseConfidence, consensusConfidence) {
    const levels = ['low', 'medium', 'high', 'very-high'];
    const baseIndex = levels.indexOf(baseConfidence);
    const consensusIndex = levels.indexOf(consensusConfidence);

    // If consensus is higher, upgrade by 1 level (but not past consensus)
    if (consensusIndex > baseIndex) {
      return levels[Math.min(baseIndex + 1, consensusIndex)];
    }

    // If consensus is lower, downgrade
    if (consensusIndex < baseIndex) {
      return consensusConfidence;
    }

    return baseConfidence;
  }

  /**
   * Get historical actual temperature (for resolution)
   */
  async getHistoricalHigh(cityName, date) {
    const city = this.getCity(cityName);
    if (!city) return null;

    const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];

    try {
      // Open-Meteo historical endpoint
      const url = `https://archive-api.open-meteo.com/v1/archive?` +
        `latitude=${city.lat}&longitude=${city.lon}` +
        `&start_date=${dateStr}&end_date=${dateStr}` +
        `&daily=temperature_2m_max` +
        `&timezone=${encodeURIComponent(city.tz)}`;

      const resp = await fetch(url);
      this.requestCount++;

      if (!resp.ok) {
        // Try the forecast API with past_days for recent dates
        return await this.getRecentHistoricalHigh(city, dateStr);
      }

      const data = await resp.json();

      if (data.daily && data.daily.temperature_2m_max && data.daily.temperature_2m_max[0] != null) {
        const highC = data.daily.temperature_2m_max[0];
        return {
          date: dateStr,
          city: city.key,
          highC: Math.round(highC * 10) / 10,
          highF: Math.round(celsiusToFahrenheit(highC) * 10) / 10,
          preferredUnit: city.unit,
          source: 'archive',
        };
      }

      return null;
    } catch (err) {
      this.log('error', 'Historical fetch failed', { city: cityName, date: dateStr, error: err.message });
      return await this.getRecentHistoricalHigh(city, dateStr);
    }
  }

  /**
   * Fallback: Get recent historical data from forecast API
   */
  async getRecentHistoricalHigh(city, dateStr) {
    try {
      const url = `${OPEN_METEO_BASE}?` +
        `latitude=${city.lat}&longitude=${city.lon}` +
        `&daily=temperature_2m_max` +
        `&past_days=7` +
        `&timezone=${encodeURIComponent(city.tz)}`;

      const resp = await fetch(url);
      this.requestCount++;

      if (!resp.ok) return null;

      const data = await resp.json();

      const idx = data.daily.time.indexOf(dateStr);
      if (idx !== -1 && data.daily.temperature_2m_max[idx] != null) {
        const highC = data.daily.temperature_2m_max[idx];
        return {
          date: dateStr,
          city: city.key,
          highC: Math.round(highC * 10) / 10,
          highF: Math.round(celsiusToFahrenheit(highC) * 10) / 10,
          preferredUnit: city.unit,
          source: 'recent',
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch forecasts for all cities
   */
  async getAllForecasts() {
    const results = new Map();

    // Get unique cities (avoid duplicates like nyc/new york)
    const uniqueCities = ['london', 'nyc', 'atlanta', 'miami', 'chicago',
                          'dallas', 'seattle', 'toronto', 'seoul',
                          'buenos aires', 'ankara', 'wellington',
                          'denver', 'phoenix', 'los angeles'];

    for (const cityKey of uniqueCities) {
      const forecast = await this.getForecast(cityKey);
      if (forecast) {
        results.set(cityKey, forecast);
      }
      // Small delay to be nice to the API
      await new Promise(r => setTimeout(r, 100));
    }

    return results;
  }

  /**
   * Get API usage stats
   */
  getStats() {
    return {
      requestCount: this.requestCount,
      lastRequestTime: this.lastRequestTime,
      dailyLimit: 10000,
      remaining: 10000 - this.requestCount,
    };
  }

  /**
   * Reset API call counter (call at start of each scan cycle)
   */
  resetStats() {
    this.requestCount = 0;
  }

  /**
   * Save forecast to history table
   * @param {Object} supabase - Supabase client
   * @param {Object} forecast - Forecast object from getForecastForDate()
   */
  async saveForecastHistory(supabase, forecast) {
    if (!supabase || !forecast) return null;

    try {
      const record = {
        city: forecast.city,
        target_date: forecast.date,
        // Primary (Open-Meteo) - keep existing columns for backwards compatibility
        high_temp_c: forecast.sources?.openMeteo?.highC || forecast.highC,
        high_temp_f: forecast.sources?.openMeteo?.highF || forecast.highF,
        confidence: forecast.confidence,
        // Tomorrow.io forecast (NYC only, deprecated)
        tomorrow_high_c: forecast.tomorrowForecast?.highC || null,
        tomorrow_high_f: forecast.tomorrowForecast?.highF || null,
        // NWS (US cities)
        nws_high_f: forecast.sources?.nws?.highF || null,
        nws_high_c: forecast.sources?.nws?.highC || null,
        // WeatherAPI (all cities)
        weatherapi_high_f: forecast.sources?.weatherApi?.highF || null,
        weatherapi_high_c: forecast.sources?.weatherApi?.highC || null,
        // Consensus metrics
        source_count: forecast.sourceCount || 1,
        source_spread_f: forecast.consensus?.spread || null,
        consensus_confidence: forecast.consensus?.confidence || null,
      };

      const { data, error } = await supabase
        .from('forecast_history')
        .insert(record)
        .select()
        .single();

      if (error) {
        // Ignore duplicate key errors (same city/date/time)
        if (!error.message.includes('duplicate')) {
          this.log('warn', 'Failed to save forecast history', { error: error.message });
        }
        return null;
      }

      return data;
    } catch (err) {
      this.log('warn', 'Forecast history save error', { error: err.message });
      return null;
    }
  }

  /**
   * Get previous forecast for comparison (from N hours ago)
   * @param {Object} supabase - Supabase client
   * @param {string} city - City name
   * @param {string} targetDate - Target date (YYYY-MM-DD)
   * @param {number} hoursAgo - Minimum hours in the past (default 1)
   */
  async getPreviousForecast(supabase, city, targetDate, hoursAgo = 1) {
    if (!supabase) return null;

    try {
      const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from('forecast_history')
        .select('*')
        .eq('city', city)
        .eq('target_date', targetDate)
        .lt('fetched_at', cutoffTime)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .single();

      if (error || !data) return null;

      return {
        city: data.city,
        date: data.target_date,
        highC: parseFloat(data.high_temp_c),
        highF: parseFloat(data.high_temp_f),
        confidence: data.confidence,
        fetchedAt: data.fetched_at,
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * Get monthly precipitation forecast
   * Sums daily precipitation forecasts for a given month
   * @param {string} cityName - City name
   * @param {number} month - Month (0-11)
   * @param {number} year - Year
   */
  async getMonthlyPrecipitationForecast(cityName, month, year) {
    const city = this.getCity(cityName);
    if (!city) return null;

    const forecast = await this.getForecast(cityName);
    if (!forecast) return null;

    // Filter forecasts for the target month
    const monthForecasts = forecast.forecasts.filter(f => {
      const d = new Date(f.date);
      return d.getMonth() === month && d.getFullYear() === year;
    });

    if (monthForecasts.length === 0) {
      this.log('warn', `No forecasts available for ${cityName} ${month + 1}/${year}`);
      return null;
    }

    // Sum precipitation
    const totalMm = monthForecasts.reduce((sum, f) => sum + (f.precipitationMm || 0), 0);
    const totalInches = Math.round((totalMm / 25.4) * 100) / 100;

    // Calculate average probability
    const avgProbability = monthForecasts.reduce((sum, f) => sum + (f.precipitationProbability || 0), 0) / monthForecasts.length;

    // Calculate days remaining in month
    const now = new Date();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysCovered = monthForecasts.length;
    const daysRemaining = daysInMonth - daysCovered;

    // Estimate total based on forecast coverage
    const coverageRatio = daysCovered / daysInMonth;
    const estimatedTotalInches = coverageRatio > 0.5
      ? totalInches / coverageRatio
      : totalInches; // If less than half month covered, just use what we have

    // Confidence based on how much of the month we can forecast
    let confidence = 'low';
    if (coverageRatio >= 0.9) confidence = 'very-high';
    else if (coverageRatio >= 0.7) confidence = 'high';
    else if (coverageRatio >= 0.5) confidence = 'medium';

    return {
      city: city.key,
      month: month,
      year: year,
      monthName: ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'][month],
      forecastDays: daysCovered,
      daysInMonth: daysInMonth,
      coverageRatio: Math.round(coverageRatio * 100) / 100,
      totalPrecipitationMm: Math.round(totalMm * 10) / 10,
      totalPrecipitationInches: totalInches,
      estimatedMonthlyInches: Math.round(estimatedTotalInches * 100) / 100,
      avgPrecipitationProbability: Math.round(avgProbability),
      confidence: confidence,
    };
  }

  /**
   * Get historical precipitation for a month (for resolution)
   * @param {string} cityName - City name
   * @param {number} month - Month (0-11)
   * @param {number} year - Year
   */
  async getHistoricalPrecipitation(cityName, month, year) {
    const city = this.getCity(cityName);
    if (!city) return null;

    // Calculate start and end dates for the month
    const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const endDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    try {
      // Open-Meteo historical endpoint
      const url = `https://archive-api.open-meteo.com/v1/archive?` +
        `latitude=${city.lat}&longitude=${city.lon}` +
        `&start_date=${startDate}&end_date=${endDate}` +
        `&daily=precipitation_sum` +
        `&timezone=${encodeURIComponent(city.tz)}`;

      const resp = await fetch(url);
      this.requestCount++;

      if (!resp.ok) {
        this.log('warn', 'Historical precipitation API error', { status: resp.status });
        return null;
      }

      const data = await resp.json();

      if (!data.daily || !data.daily.precipitation_sum) {
        this.log('warn', 'No historical precipitation data', { city: cityName, month, year });
        return null;
      }

      // Sum all daily precipitation values
      const dailyPrecip = data.daily.precipitation_sum;
      const totalMm = dailyPrecip.reduce((sum, val) => sum + (val || 0), 0);
      const totalInches = Math.round((totalMm / 25.4) * 100) / 100;

      return {
        city: city.key,
        month: month,
        year: year,
        startDate,
        endDate,
        totalPrecipitationMm: Math.round(totalMm * 10) / 10,
        totalPrecipitationInches: totalInches,
        daysWithData: dailyPrecip.filter(v => v !== null).length,
        source: 'archive',
      };
    } catch (err) {
      this.log('error', 'Historical precipitation fetch failed', { city: cityName, month, year, error: err.message });
      return null;
    }
  }

  /**
   * Record forecast accuracy after market resolution
   * @param {Object} supabase - Supabase client
   * @param {string} city - City name
   * @param {string} marketDate - Market date (YYYY-MM-DD)
   * @param {number} actualTempF - Actual temperature in Fahrenheit
   */
  async recordForecastAccuracy(supabase, city, marketDate, actualTempF) {
    if (!supabase) return null;

    try {
      // Get the most recent forecast for this market
      const { data: forecasts } = await supabase
        .from('forecast_history')
        .select('*')
        .eq('city', city)
        .eq('target_date', marketDate)
        .order('fetched_at', { ascending: false })
        .limit(1);

      if (!forecasts || forecasts.length === 0) return null;

      const forecast = forecasts[0];

      // Calculate errors for each source
      const openMeteoError = forecast.high_temp_f
        ? Math.abs(parseFloat(forecast.high_temp_f) - actualTempF)
        : null;
      const nwsError = forecast.nws_high_f
        ? Math.abs(parseFloat(forecast.nws_high_f) - actualTempF)
        : null;
      const weatherApiError = forecast.weatherapi_high_f
        ? Math.abs(parseFloat(forecast.weatherapi_high_f) - actualTempF)
        : null;

      // Determine best source
      const errors = [
        { source: 'open-meteo', error: openMeteoError },
        { source: 'nws', error: nwsError },
        { source: 'weatherapi', error: weatherApiError },
      ].filter(e => e.error !== null);

      const bestSource = errors.length > 0
        ? errors.reduce((a, b) => a.error < b.error ? a : b).source
        : null;

      // Calculate consensus forecast (average of available)
      const availableForecasts = [
        forecast.high_temp_f,
        forecast.nws_high_f,
        forecast.weatherapi_high_f,
      ].filter(f => f !== null).map(f => parseFloat(f));

      const consensusForecast = availableForecasts.length > 0
        ? availableForecasts.reduce((a, b) => a + b, 0) / availableForecasts.length
        : null;
      const consensusError = consensusForecast !== null
        ? Math.abs(consensusForecast - actualTempF)
        : null;

      const accuracy = {
        city,
        market_date: marketDate,
        open_meteo_forecast_f: forecast.high_temp_f ? parseFloat(forecast.high_temp_f) : null,
        open_meteo_error_f: openMeteoError,
        // NWS
        nws_forecast_f: forecast.nws_high_f ? parseFloat(forecast.nws_high_f) : null,
        nws_error_f: nwsError,
        // WeatherAPI
        weatherapi_forecast_f: forecast.weatherapi_high_f ? parseFloat(forecast.weatherapi_high_f) : null,
        weatherapi_error_f: weatherApiError,
        // Actual and best source
        actual_temp_f: actualTempF,
        best_source: bestSource,
        // Consensus
        consensus_forecast_f: consensusForecast ? Math.round(consensusForecast * 10) / 10 : null,
        consensus_error_f: consensusError ? Math.round(consensusError * 10) / 10 : null,
        // Keep deprecated columns
        tomorrow_forecast_f: forecast.tomorrow_high_f ? parseFloat(forecast.tomorrow_high_f) : null,
        tomorrow_error_f: forecast.tomorrow_high_f
          ? Math.abs(parseFloat(forecast.tomorrow_high_f) - actualTempF)
          : null,
      };

      const { data, error } = await supabase
        .from('forecast_accuracy')
        .upsert(accuracy, { onConflict: 'city,market_date' })
        .select()
        .single();

      if (error) {
        this.log('warn', 'Failed to record forecast accuracy', { error: error.message });
        return null;
      }

      this.log('info', 'Recorded multi-source accuracy', {
        city,
        date: marketDate,
        actual: actualTempF,
        openMeteoError: openMeteoError?.toFixed(1),
        nwsError: nwsError?.toFixed(1),
        weatherApiError: weatherApiError?.toFixed(1),
        bestSource,
      });

      return data;
    } catch (err) {
      this.log('warn', 'Forecast accuracy recording error', { error: err.message });
      return null;
    }
  }

  /**
   * Compare current forecast to previous forecast
   * Returns shift data if significant change detected
   * @param {Object} current - Current forecast
   * @param {Object} previous - Previous forecast (from hours ago)
   * @param {Object} thresholds - Shift thresholds
   */
  compareForecast(current, previous, thresholds = {}) {
    if (!current || !previous) return null;

    const {
      minShiftF = 2,  // Minimum 2°F shift
      minShiftC = 1,  // Minimum 1°C shift
    } = thresholds;

    const shiftF = current.highF - previous.highF;
    const shiftC = current.highC - previous.highC;

    const isSignificant = Math.abs(shiftF) >= minShiftF || Math.abs(shiftC) >= minShiftC;

    if (!isSignificant) return null;

    return {
      city: current.city,
      date: current.date,
      currentHighF: current.highF,
      currentHighC: current.highC,
      previousHighF: previous.highF,
      previousHighC: previous.highC,
      shiftF: Math.round(shiftF * 10) / 10,
      shiftC: Math.round(shiftC * 10) / 10,
      direction: shiftF > 0 ? 'warmer' : 'colder',
      hoursElapsed: previous.fetchedAt
        ? Math.round((Date.now() - new Date(previous.fetchedAt).getTime()) / (1000 * 60 * 60) * 10) / 10
        : null,
    };
  }
}

module.exports = {
  WeatherAPI,
  CITIES,
  celsiusToFahrenheit,
  fahrenheitToCelsius
};
