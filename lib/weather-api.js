/**
 * Weather API Wrapper
 *
 * Uses Open-Meteo (free, 10k requests/day) as primary source.
 * Provides forecasts and historical data for temperature markets.
 */

const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';

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
        `&daily=temperature_2m_max,temperature_2m_min` +
        `&timezone=${encodeURIComponent(city.tz)}` +
        `&forecast_days=7`;

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

        forecasts.push({
          date: data.daily.time[i],
          city: city.key,
          highC: Math.round(highC * 10) / 10,
          lowC: Math.round(lowC * 10) / 10,
          highF: Math.round(celsiusToFahrenheit(highC) * 10) / 10,
          lowF: Math.round(celsiusToFahrenheit(lowC) * 10) / 10,
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

    return dayForecast;
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
        high_temp_c: forecast.highC,
        high_temp_f: forecast.highF,
        confidence: forecast.confidence,
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
