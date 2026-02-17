export interface City {
  name: string;
  lng: number;
  lat: number;
  minZoom: number;
}

export const CITIES: City[] = [
  // Major European capitals / large cities – visible from zoom 4
  { name: "Berlin", lng: 13.405, lat: 52.52, minZoom: 4 },
  { name: "Paris", lng: 2.3522, lat: 48.8566, minZoom: 4 },
  { name: "London", lng: -0.1276, lat: 51.5074, minZoom: 4 },
  { name: "Madrid", lng: -3.7038, lat: 40.4168, minZoom: 4 },
  { name: "Rome", lng: 12.4964, lat: 41.9028, minZoom: 4 },
  { name: "Warsaw", lng: 21.0122, lat: 52.2297, minZoom: 4 },
  { name: "Vienna", lng: 16.3738, lat: 48.2082, minZoom: 4 },
  { name: "Amsterdam", lng: 4.9041, lat: 52.3676, minZoom: 5 },
  { name: "Brussels", lng: 4.3517, lat: 50.8503, minZoom: 5 },
  { name: "Prague", lng: 14.4378, lat: 50.0755, minZoom: 5 },
  { name: "Budapest", lng: 19.0402, lat: 47.4979, minZoom: 5 },
  { name: "Stockholm", lng: 18.0686, lat: 59.3293, minZoom: 5 },
  { name: "Kyiv", lng: 30.5234, lat: 50.4501, minZoom: 5 },
  { name: "Bucharest", lng: 26.1025, lat: 44.4268, minZoom: 5 },

  // German cities – visible from zoom 5–6
  { name: "Hamburg", lng: 9.9937, lat: 53.5511, minZoom: 5 },
  { name: "Munich", lng: 11.582, lat: 48.1351, minZoom: 5 },
  { name: "Cologne", lng: 6.9603, lat: 50.9333, minZoom: 5 },
  { name: "Frankfurt", lng: 8.6821, lat: 50.1109, minZoom: 5 },
  { name: "Stuttgart", lng: 9.1829, lat: 48.7758, minZoom: 6 },
  { name: "Düsseldorf", lng: 6.7735, lat: 51.2217, minZoom: 6 },
  { name: "Leipzig", lng: 12.3731, lat: 51.3397, minZoom: 6 },
  { name: "Dortmund", lng: 7.4653, lat: 51.5136, minZoom: 6 },
  { name: "Essen", lng: 7.0116, lat: 51.4556, minZoom: 6 },
  { name: "Bremen", lng: 8.8017, lat: 53.0793, minZoom: 6 },
  { name: "Dresden", lng: 13.7373, lat: 51.0504, minZoom: 6 },
  { name: "Hanover", lng: 9.7332, lat: 52.3759, minZoom: 6 },
  { name: "Nuremberg", lng: 11.0767, lat: 49.4521, minZoom: 6 },

  // Switzerland / Austria
  { name: "Zurich", lng: 8.5417, lat: 47.3769, minZoom: 6 },
  { name: "Geneva", lng: 6.1432, lat: 46.2044, minZoom: 6 },
  { name: "Bern", lng: 7.4474, lat: 46.948, minZoom: 7 },
  { name: "Graz", lng: 15.4395, lat: 47.0707, minZoom: 7 },

  // Other notable cities
  { name: "Lisbon", lng: -9.1393, lat: 38.7223, minZoom: 5 },
  { name: "Barcelona", lng: 2.1734, lat: 41.3851, minZoom: 5 },
  { name: "Milan", lng: 9.19, lat: 45.4654, minZoom: 5 },
  { name: "Copenhagen", lng: 12.5683, lat: 55.6761, minZoom: 5 },
  { name: "Oslo", lng: 10.7522, lat: 59.9139, minZoom: 5 },
  { name: "Helsinki", lng: 24.9384, lat: 60.1699, minZoom: 5 },
  { name: "Athens", lng: 23.7275, lat: 37.9838, minZoom: 5 },
];
