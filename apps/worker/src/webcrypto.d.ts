// Workers' ambient signature combines all export formats into one return type.
interface SubtleCrypto {
  exportKey(format: "jwk", key: CryptoKey): Promise<JsonWebKey>;
}
