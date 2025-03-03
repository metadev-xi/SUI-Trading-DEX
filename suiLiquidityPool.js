/**
 * SUI Trading DEX - Liquidity Pool Implementation
 * 
 * This module implements the core liquidity pool functionality for the SUI Trading DEX,
 * leveraging SUI's object model and Move language capabilities to create
 * programmable liquidity with advanced features.
 */

const { JsonRpcProvider, devnetConnection, testnetConnection, mainnetConnection } = require('@mysten/sui.js');
const { Ed25519Keypair, RawSigner } = require('@mysten/sui.js/cryptography');
const { TransactionBlock } = require('@mysten/sui.js/transactions');
const { bcs } = require('@mysten/sui.js/bcs');

// Constants for the DEX
const DEX_PACKAGE_ID = '0x123456789abcdef123456789abcdef123456789abcdef123456789abcdef1234';
const MODULE_NAME = 'liquidity_pool';
const LP_REGISTRY_ID = '0xabcdef123456789abcdef123456789abcdef123456789abcdef123456789abcd';
const FEE_TIERS = {
  LOW: { fee: 0.0005, tickSpacing: 10 },    // 0.05% fee, tick spacing 10
  MEDIUM: { fee: 0.003, tickSpacing: 60 },  // 0.3% fee, tick spacing 60
  HIGH: { fee: 0.01, tickSpacing: 200 }     // 1% fee, tick spacing 200
};

class SuiLiquidityPool {
  /**
   * Initialize the SUI Liquidity Pool system
   * @param {Object} config - Configuration options
   */
  constructor(config = {}) {
    // Set up RPC connection
    const network = config.network || 'mainnet';
    switch (network) {
      case 'devnet':
        this.provider = new JsonRpcProvider(devnetConnection);
        break;
      case 'testnet':
        this.provider = new JsonRpcProvider(testnetConnection);
        break;
      case 'mainnet':
      default:
        this.provider = new JsonRpcProvider(config.rpcEndpoint || mainnetConnection);
    }
    
    this.packageId = config.packageId || DEX_PACKAGE_ID;
    this.lpRegistryId = config.lpRegistryId || LP_REGISTRY_ID;
    this.moduleName = config.moduleName || MODULE_NAME;
    this.poolCache = new Map();
  }

  /**
   * Create a signer from a private key
   * @param {string} privateKey - Private key in base64 format
   * @returns {RawSigner} SUI signer
   */
  createSigner(privateKey) {
    const keypair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKey, 'base64'));
    return new RawSigner(keypair, this.provider);
  }

  /**
   * Create a new liquidity pool
   * @param {Object} params - Pool creation parameters
   * @returns {Promise<Object>} Created pool details
   */
  async createPool(params) {
    const {
      coinTypeA,
      coinTypeB,
      feeTier = 'MEDIUM',
      signer,
      initialPrice = "1.0"
    } = params;

    try {
      // Ensure coin types are ordered for consistent pool creation
      const [tokenX, tokenY] = this.sortTokens(coinTypeA, coinTypeB);
      
      // Get fee tier settings
      const tier = FEE_TIERS[feeTier];
      if (!tier) {
        throw new Error(`Invalid fee tier: ${feeTier}. Must be LOW, MEDIUM, or HIGH.`);
      }
      
      // Convert initial price to SqrtPriceX96 format (special fixed-point format for Uniswap v3 style pools)
      const sqrtPriceX96 = this.priceToSqrtPriceX96(initialPrice);
      
      // Create transaction block
      const txb = new TransactionBlock();
      
      // Get gas object
      const [gasObject] = await this.provider.getCoins({
        owner: signer.getAddress(),
        limit: 1
      });
      
      if (!gasObject) {
        throw new Error('No gas objects available for transaction');
      }
      
      // Add create_pool call to transaction
      txb.moveCall({
        target: `${this.packageId}::${this.moduleName}::create_pool`,
        arguments: [
          txb.object(this.lpRegistryId),                  // Registry object
          txb.pure(tokenX),                               // Token X type
          txb.pure(tokenY),                               // Token Y type
          txb.pure(tier.fee * 1000000),                   // Fee in ppm (parts per million)
          txb.pure(tier.tickSpacing),                     // Tick spacing
          txb.pure(sqrtPriceX96.toString())               // Initial sqrt price
        ],
        typeArguments: [tokenX, tokenY]
      });
      
      // Set gas coin
      txb.setGasPayment([gasObject.coinObjectId]);
      
      // Sign and execute transaction
      const result = await signer.signAndExecuteTransactionBlock({
        transactionBlock: txb,
        options: {
          showEffects: true,
          showEvents: true
        }
      });
      
      if (result.effects.status.status !== 'success') {
        throw new Error(`Transaction failed: ${result.effects.status.error}`);
      }
      
      // Extract pool ID from transaction events
      const poolCreatedEvent = result.events.find(
        event => event.type.includes(`${this.moduleName}::PoolCreated`)
      );
      
      if (!poolCreatedEvent) {
        throw new Error('Pool creation event not found in transaction');
      }
      
      const poolId = poolCreatedEvent.parsedJson.pool_id;
      
      // Get pool details
      const poolDetails = await this.getPoolDetails(poolId);
      
      return {
        success: true,
        transactionDigest: result.digest,
        poolId,
        tokenX,
        tokenY,
        feeTier,
        tickSpacing: tier.tickSpacing,
        fee: tier.fee,
        sqrtPriceX96: sqrtPriceX96.toString(),
        liquidity: "0",
        ...poolDetails
      };
    } catch (error) {
      console.error('Error creating liquidity pool:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get pool details
   * @param {string} poolId - Pool ID
   * @returns {Promise<Object>} Pool details
   */
  async getPoolDetails(poolId) {
    try {
      // Check cache first
      if (this.poolCache.has(poolId)) {
        return this.poolCache.get(poolId);
      }
      
      // Fetch pool object from SUI
      const poolObject = await this.provider.getObject({
        id: poolId,
        options: {
          showContent: true,
          showType: true
        }
      });
      
      if (!poolObject || !poolObject.data || !poolObject.data.content) {
        throw new Error(`Pool with ID ${poolId} not found`);
      }
      
      const pool = poolObject.data.content.fields;
      const poolType = poolObject.data.type;
      
      // Extract token types from pool type
      const typeMatch = poolType.match(/<([^,]+),\s*([^>]+)>/);
      if (!typeMatch) {
        throw new Error(`Invalid pool type format: ${poolType}`);
      }
      
      const [_, tokenX, tokenY] = typeMatch;
      
      // Extract core pool data
      const sqrtPriceX96 = pool.sqrt_price_x96;
      const liquidity = pool.liquidity;
      const fee = parseInt(pool.fee) / 1000000; // Convert from PPM to decimal
      const tickSpacing = parseInt(pool.tick_spacing);
      const currentTick = parseInt(pool.current_tick);
      
      // Calculate current price from sqrtPriceX96
      const price = this.sqrtPriceX96ToPrice(sqrtPriceX96);
      
      // Get token metadata (simplified - would need more robust implementation)
      const [tokenXMetadata, tokenYMetadata] = await Promise.all([
        this.getTokenMetadata(tokenX),
        this.getTokenMetadata(tokenY)
      ]);
      
      const poolDetails = {
        id: poolId,
        tokenX,
        tokenY,
        tokenXMetadata,
        tokenYMetadata,
        sqrtPriceX96,
        price: price.toString(),
        liquidity,
        fee,
        tickSpacing,
        currentTick,
        tvl: await this.calculatePoolTVL(poolId, tokenX, tokenY, liquidity, sqrtPriceX96, currentTick)
      };
      
      // Cache the pool details
      this.poolCache.set(poolId, poolDetails);
      
      return poolDetails;
    } catch (error) {
      console.error(`Error fetching pool details for ${poolId}:`, error);
      throw new Error(`Failed to fetch pool details: ${error.message}`);
    }
  }

  /**
   * Add liquidity to a pool
   * @param {Object} params - Liquidity addition parameters
   * @returns {Promise<Object>} Result of liquidity addition
   */
  async addLiquidity(params) {
    const {
      poolId,
      tickLower,
      tickUpper,
      amountX,
      amountY,
      signer,
      slippageTolerance = 0.01 // 1% default slippage tolerance
    } = params;

    try {
      // Get pool details
      const pool = await this.getPoolDetails(poolId);
      
      // Create transaction block
      const txb = new TransactionBlock();
      
      // Get coins for token X and Y
      const [coinsX, coinsY] = await Promise.all([
        this.provider.getCoins({
          owner: signer.getAddress(),
          coinType: pool.tokenX
        }),
        this.provider.getCoins({
          owner: signer.getAddress(),
          coinType: pool.tokenY
        })
      ]);
      
      if (coinsX.length === 0 || coinsY.length === 0) {
        throw new Error('Insufficient coins for liquidity provision');
      }
      
      // Merge coins if needed (simplified, would need more robust implementation)
      const coinX = coinsX[0].coinObjectId;
      const coinY = coinsY[0].coinObjectId;
      
      // Calculate amount0Min and amount1Min based on slippage tolerance
      const amount0Min = Math.floor(amountX * (1 - slippageTolerance));
      const amount1Min = Math.floor(amountY * (1 - slippageTolerance));
      
      // Add add_liquidity call to transaction
      txb.moveCall({
        target: `${this.packageId}::${this.moduleName}::add_liquidity`,
        arguments: [
          txb.object(poolId),                    // Pool object
          txb.pure(tickLower),                   // Lower tick
          txb.pure(tickUpper),                   // Upper tick
          txb.object(coinX),                     //
