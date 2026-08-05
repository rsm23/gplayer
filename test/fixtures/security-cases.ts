export const securitySalt = 'compatibility-test-salt'

export const securityCases = [
  {
    plainText: 'hello',
    encrypted:
      'i5KS7HBcAYqkqlSo7La9I1ZoLwLQ9UX5XJMt+ZD27nrWEYk5sVxWlr50JQXgRZNPnxtOxvIkzL+xHbfOzHnh6Q==',
    urlToken:
      'YVFESFFHTmMzd1hSaXVFZnZLNW1xZWNVcW45MlRidTJubU8zeE9adEh6eGI5RVFIS3htN1R3STJkUGp1S3RBNFhwVlJjbkNmZmpzWkgxZHRMZTkzTHc9PQ,,'
  },
  {
    plainText: 'source=db&id=42',
    encrypted:
      '4Ft5TmHCtlfgfKbPXfXffZY0DxCHaZv7UjHquTjaDb3UqVsTru+NRn6tz4EXqoslV/RgcriWWWJJZdu6aYymTg==',
    urlToken:
      'OHFuRnFmWEF0Z0d2VzBwcDhpK3BXclA2VWkxRG80bW5Jc1RBbzh0VzBqemY1UEJRQ2JOZ1VFUHA3SUltMEZKYUxFM0g1SWdtUDk4R1VLeHE2RU5OSGc9PQ,,'
  },
  {
    plainText: 'https://example.com/video.m3u8',
    encrypted:
      '/mAyq0dg90i9rQeXxcEXyvxwKKm4lYzdLOdeu8dl9TP2c/KhxsvdW5jI8G0mIek4VYI7rnR5C3ZvLx/vaZVloGTfE7oLHBOSvarZc63S68c=',
    urlToken:
      'T2Vyb25GVTk2QlZGaEM5OHhRVGFHZXhTVDlFYmRXdUxENW1HMUlMdFdrWU8wWk1FTUtGbS91dWdmYWlMMGVZUTBIVkpkSlZhRWhyVG5WbDVSMXlvL3dZWklHV1ExWXJkaXVuSG0xTzlpSmM9'
  }
] as const

export const responseCases = [
  {
    plainText: 'hello',
    password: 'response-password',
    encrypted: 'Tdnrjmoc2bW0yKzXacFx5FIqTD5sYPEQ8Az2sChRTYs='
  },
  {
    plainText: 'source=db&id=42',
    password: 'response-password',
    encrypted: 'QkCwlEnm86NBSfkxx6zgYktQsaR7NIIVxBXickHfurA='
  }
] as const

export const legacyDataCases = [
  {
    plainText: 'hello',
    encrypted: 'TkNzVHUzbkhrUHVJY1V6c1Brcmw3dz09OjoxMjM0NTY3ODkwYWJjZGVm'
  },
  {
    plainText: 'https://example.com/video.mp4',
    encrypted:
      'TG5zUG4xNVVKbmRrMkgrMDZWT3BOSWwrUzdDaHdjNFNwMEZINTEwN2NSYz06OjEyMzQ1Njc4OTBhYmNkZWY='
  }
] as const
